import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildNotificationDigestItem,
  buildNotificationMessage,
  notifiableEventFor,
  notificationDedupDiscriminator,
  type NotifiableAuditEntry,
} from '../src/notifications/events.js';
import { notificationDedupKey } from '../src/queue.js';
import {
  channelConfigSchema,
  channelSecretFields,
  presentNotificationChannels,
} from '../src/notifications/catalog.js';
import { notificationMessageSchema, renderPlainText } from '../src/notifications/message.js';
import { getNotificationChannel } from '../src/notifications/index.js';
import { escapeMarkdownV2 } from '../src/notifications/telegram.js';
import {
  describeFailure,
  redactSecrets,
  type NotificationTransports,
  type SmtpEnvelope,
  type SmtpOptions,
} from '../src/notifications/types.js';

/**
 * Everything is checked **without network**: the transports are injected. It is
 * the reason for being of `NotificationTransports` — a channel must not require
 * an SMTP server, a Telegram token and a Discord channel to be testable.
 */

type Call = { url: string; init: RequestInit };

function fakeTransports(
  respond: (call: Call) => Response = () => new Response('{}', { status: 200 }),
): {
  transports: NotificationTransports;
  calls: Call[];
  mails: { options: SmtpOptions; envelopes: SmtpEnvelope[]; verified: number };
} {
  const calls: Call[] = [];
  const mails = { options: {} as SmtpOptions, envelopes: [] as SmtpEnvelope[], verified: 0 };

  return {
    calls,
    mails,
    transports: {
      timeoutMs: 1_000,
      fetch: (url, init) => {
        const call = { url, init };
        calls.push(call);
        return Promise.resolve(respond(call));
      },
      smtp: (options) => {
        mails.options = options;
        return {
          verify: () => {
            mails.verified += 1;
            return Promise.resolve();
          },
          send: (envelope) => {
            mails.envelopes.push(envelope);
            return Promise.resolve();
          },
          close: () => {},
        };
      },
    },
  };
}

function body(call: Call): Record<string, unknown> {
  return JSON.parse(String(call.init.body)) as Record<string, unknown>;
}

const CTX = {
  // The language is an instance setting: the worker resolves it and passes it
  // down here.
  language: 'fr' as const,
  instance: 'Panel de recette',
  panelUrl: 'https://panel.example.test',
  actor: 'admin@example.test',
  occurredAt: '2026-09-11T10:00:00.000Z',
};

function entry(overrides: Partial<NotifiableAuditEntry>): NotifiableAuditEntry {
  return {
    action: 'deployment.failed',
    resourceType: 'deployment',
    resourceId: '11111111-1111-1111-1111-111111111111',
    actorId: 'user-1',
    before: null,
    after: null,
    ...overrides,
  };
}

describe('notifications — the events table', () => {
  it('recognizes the five chosen events', () => {
    assert.equal(notifiableEventFor(entry({ after: { error: 'boum' } })), 'deployment.failed');
    assert.equal(
      notifiableEventFor(entry({ after: { failedStep: 'scan', error: 'CVE' } })),
      'deployment.scan_blocked',
    );
    assert.equal(
      notifiableEventFor(entry({ action: 'deployment.rolled_back.automatic' })),
      'deployment.rolled_back',
    );
    assert.equal(
      notifiableEventFor(entry({ action: 'user.2fa.reset', resourceType: 'user' })),
      'security.two_factor_reset',
    );
    assert.equal(
      notifiableEventFor(entry({ action: 'user.role.changed', resourceType: 'user' })),
      'security.role_changed',
    );
  });

  it('ignores everything else — that is what holds the volume', () => {
    for (const action of [
      'deployment.created',
      'permission.denied',
      'auth.logout',
      'settings.updated',
      'target.preflight.completed',
      // Anti-loop: warning that we could not warn would restart the delivery on
      // itself.
      'notification.delivery.failed',
    ]) {
      assert.equal(notifiableEventFor(entry({ action })), null, action);
    }
  });

  it('a public sign-up warns, an account created by an administrator does not', () => {
    const signup = entry({
      action: 'user.created',
      resourceType: 'user',
      actorId: null,
      after: { email: 'nouveau@example.test', name: 'Nouveau', role: 'no-access' },
    });
    assert.equal(notifiableEventFor(signup), 'security.signup_pending');
    for (const role of ['viewer', 'operator', 'admin']) {
      assert.equal(
        notifiableEventFor({ ...signup, after: { email: 'x@example.test', role } }),
        null,
        role,
      );
    }
    const message = buildNotificationMessage('security.signup_pending', signup, {
      ...CTX,
      actor: null,
    });
    notificationMessageSchema.parse(message);
    assert.ok(message.title.includes('nouveau@example.test'));
    assert.equal(message.url, 'https://panel.example.test/admin/users');
  });

  it('an account born from single sign-on says so, and names the provider', () => {
    const created = entry({
      action: 'user.created',
      resourceType: 'user',
      actorId: null,
      after: {
        email: 'chloe@example.test',
        role: 'no-access',
        origin: 'sso',
        provider: 'Keycloak',
      },
    });
    assert.equal(notifiableEventFor(created), 'security.signup_pending');
    const message = buildNotificationMessage('security.signup_pending', created, {
      ...CTX,
      actor: null,
    });
    assert.ok(message.body.includes('Keycloak'));
    assert.ok(!message.body.includes('inscription publique'));
  });

  it('a successful deployment names itself: application, version, machine, URL', () => {
    const succeeded = entry({
      action: 'deployment.succeeded',
      after: {
        application: 'api-facturation',
        targetName: 'prod-1',
        version: 12,
        status: 'success',
        url: 'https://api.example.test',
      },
    });
    assert.equal(notifiableEventFor(succeeded), 'deployment.succeeded');
    const message = buildNotificationMessage('deployment.succeeded', succeeded, CTX);
    notificationMessageSchema.parse(message);
    assert.equal(message.severity, 'info');
    assert.ok(message.title.includes('api-facturation'));
    assert.ok(message.body.includes('12') && message.body.includes('prod-1'));
    assert.ok(message.body.includes('https://api.example.test'));
  });

  it('a forecast warns once, as a sentence, and leads to its subject’s drawer', () => {
    const raised = entry({
      action: 'forecast.raised',
      resourceType: 'forecast',
      resourceId: '22222222-2222-2222-2222-222222222222',
      actorId: null,
      after: {
        kind: 'latency_degrading',
        subjectType: 'monitor',
        subjectId: 'm-1',
        subjectName: 'API facturation',
        severity: 'soon',
        etaAt: null,
        detail: { recentMs: 477, baselineMs: 142, ratio: 3.4 },
      },
    });
    assert.equal(notifiableEventFor(raised), 'forecast.raised');
    assert.equal(notifiableEventFor({ ...raised, action: 'forecast.cleared' }), null);
    const message = buildNotificationMessage('forecast.raised', raised, CTX);
    notificationMessageSchema.parse(message);
    assert.equal(message.title, 'Sonde plus lente — API facturation');
    assert.match(message.body, /477 ms depuis 24 h, contre 142 ms d’habitude \(×3,4\)/);
    assert.deepEqual(
      message.fields.find((field) => field.label === 'Sonde'),
      { label: 'Sonde', value: 'API facturation' },
    );
    assert.ok(message.url?.endsWith('/monitors?monitor=m-1'));
  });

  it('an unreachable machine warns, and its return says the duration', () => {
    const down = entry({
      action: 'target.unreachable',
      resourceType: 'target',
      actorId: null,
      after: {
        targetName: 'prod-1',
        host: '10.0.0.12',
        downSeconds: 300,
        failures: 2,
        error: 'connexion refusée',
      },
    });
    assert.equal(notifiableEventFor(down), 'target.unreachable');
    const alert = buildNotificationMessage('target.unreachable', down, { ...CTX, actor: null });
    notificationMessageSchema.parse(alert);
    assert.equal(alert.severity, 'critical');
    assert.ok(alert.body.includes('prod-1') && alert.body.includes('10.0.0.12'));
    assert.ok(alert.body.includes('5 min') && alert.body.includes('connexion refusée'));

    const up = entry({
      action: 'target.reachable',
      resourceType: 'target',
      actorId: null,
      after: { targetName: 'prod-1', host: '10.0.0.12', downSeconds: 3900 },
    });
    assert.equal(notifiableEventFor(up), 'target.reachable');
    const back = buildNotificationMessage('target.reachable', up, { ...CTX, actor: null });
    notificationMessageSchema.parse(back);
    assert.ok(back.body.includes('1 h 5'));
  });

  it('a certificate about to expire warns, its renewal too', () => {
    const expiring = entry({
      action: 'route.certificate.expiring',
      resourceType: 'application',
      actorId: null,
      after: {
        hostname: 'boutique.example.test',
        application: 'boutique',
        targetName: 'prod-1',
        notAfter: '2026-10-11T08:00:00.000Z',
        daysLeft: 8,
        issuer: "Let's Encrypt R11",
      },
    });
    assert.equal(notifiableEventFor(expiring), 'route.certificate_expiring');
    const warning = buildNotificationMessage('route.certificate_expiring', expiring, {
      ...CTX,
      actor: null,
    });
    notificationMessageSchema.parse(warning);
    assert.equal(warning.severity, 'warning');
    assert.ok(warning.body.includes('2026-10-11') && warning.body.includes('8'));

    const renewed = entry({
      action: 'route.certificate.renewed',
      resourceType: 'application',
      actorId: null,
      after: {
        hostname: 'boutique.example.test',
        application: 'boutique',
        notAfter: '2027-01-02T08:00:00.000Z',
      },
    });
    assert.equal(notifiableEventFor(renewed), 'route.certificate_renewed');
    notificationMessageSchema.parse(
      buildNotificationMessage('route.certificate_renewed', renewed, { ...CTX, actor: null }),
    );
  });

  it('a created API token warns, without ever carrying the token', () => {
    const created = entry({
      action: 'api_token.created',
      resourceType: 'api_token',
      after: {
        name: 'CI GitHub',
        prefix: 'pup_AbCdEfGh',
        ownerEmail: 'camille@example.test',
        permissions: ['deployment:create', 'deployment:read'],
        applicationIds: ['22222222-2222-2222-2222-222222222222'],
        expiresAt: null,
      },
    });
    assert.equal(notifiableEventFor(created), 'security.api_token_created');
    const message = buildNotificationMessage('security.api_token_created', created, CTX);
    notificationMessageSchema.parse(message);
    assert.ok(message.title.includes('CI GitHub'));
    assert.ok(message.body.includes('camille@example.test'));
    assert.ok(message.body.includes('2 permission'));
    assert.ok(message.fields.some((field) => field.value === 'pup_AbCdEfGh'));
  });

  it('an unexpected host key on a target warns, and names both keys', () => {
    const mismatch = entry({
      action: 'target.host_key.mismatch',
      resourceType: 'target',
      resourceId: '22222222-2222-2222-2222-222222222222',
      actorId: null,
      before: { fingerprint: 'SHA256:ancienne' },
      after: { name: 'prod-1', host: '10.0.0.5', presented: 'SHA256:nouvelle' },
    });
    assert.equal(notifiableEventFor(mismatch), 'security.host_key_changed');
    const message = buildNotificationMessage('security.host_key_changed', mismatch, CTX);
    notificationMessageSchema.parse(message);
    assert.equal(message.severity, 'critical');
    assert.match(message.title, /prod-1/);
    assert.ok(message.fields.some((field) => field.value === 'SHA256:ancienne'));
    assert.ok(message.fields.some((field) => field.value === 'SHA256:nouvelle'));
    assert.equal(
      message.url,
      'https://panel.example.test/targets/22222222-2222-2222-2222-222222222222',
    );
    // Accepting or dismissing a key is a gesture, not an alert.
    assert.equal(notifiableEventFor(entry({ action: 'target.host_key.accepted' })), null);
    assert.equal(notifiableEventFor(entry({ action: 'target.host_key.recorded' })), null);
  });

  it('a manual rollback is not an automatic rollback', () => {
    assert.equal(notifiableEventFor(entry({ action: 'deployment.rolled_back' })), null);
  });

  it('composes a valid neutral message, panel link included', () => {
    const key = notifiableEventFor(entry({ after: { failedStep: 'healthcheck', error: 'timeout' } }));
    assert.equal(key, 'deployment.failed');

    const message = buildNotificationMessage(
      'deployment.failed',
      entry({ after: { failedStep: 'healthcheck', error: 'timeout' } }),
      CTX,
    );

    notificationMessageSchema.parse(message);
    assert.equal(message.severity, 'critical');
    assert.equal(message.instance, 'Panel de recette');
    assert.equal(
      message.url,
      'https://panel.example.test/deployments/11111111-1111-1111-1111-111111111111',
    );
    assert.ok(message.fields.some((field) => field.value === 'healthcheck'));
    assert.ok(message.fields.some((field) => field.value === 'admin@example.test'));
    // The neutral message carries no markup: neither HTML nor Markdown.
    assert.ok(!/[<>*`]/.test(message.body));
  });

  it('survives a malformed audit payload', () => {
    const message = buildNotificationMessage(
      'security.role_changed',
      entry({ action: 'user.role.changed', after: 'pas un objet', before: null }),
      { ...CTX, actor: null },
    );
    notificationMessageSchema.parse(message);
  });

  it('renders a readable plain text', () => {
    const text = renderPlainText(
      buildNotificationMessage('deployment.failed', entry({ after: { error: 'boum' } }), CTX),
    );
    assert.ok(text.includes('Déploiement en échec'));
    assert.ok(text.includes('https://panel.example.test/deployments/'));
  });
});

describe('notifications — the catalog', () => {
  it('refuses a configuration missing a required field', () => {
    assert.throws(() => channelConfigSchema('smtp').parse({ from: 'a@b.test', to: 'c@d.test' }));
    assert.throws(() => channelConfigSchema('webhook').parse({}));
    // A URL that is not one must not pass either.
    assert.throws(() => channelConfigSchema('webhook').parse({ url: 'not-a-url' }));
  });

  it('applies the declared default values', () => {
    const parsed = channelConfigSchema('smtp').parse({
      host: 'smtp.example.test',
      from: 'panel@example.test',
      to: 'ops@example.test',
    }) as Record<string, unknown>;
    assert.equal(parsed.port, 587);
    assert.equal(parsed.security, 'starttls');
    assert.equal(parsed.rejectUnauthorized, true);
  });

  it('designates the secret fields, and the presented catalog carries no schema', () => {
    assert.deepEqual(channelSecretFields('telegram'), ['botToken']);
    assert.deepEqual(channelSecretFields('discord'), ['webhookUrl']);
    // Serializable: a `RegExp` or a function would become `{}` in JSON, and the
    // screen would show an empty form without the slightest error.
    const presented = presentNotificationChannels();
    assert.deepEqual(JSON.parse(JSON.stringify(presented)), presented);
    assert.ok(presented.every((channel) => channel.fields.every((f) => !('schema' in f))));
  });
});

describe('notifications — the channels', () => {
  const message = buildNotificationMessage(
    'deployment.scan_blocked',
    entry({ after: { failedStep: 'scan', error: 'CVE-2026-1 (CRITICAL)' } }),
    CTX,
  );

  it('webhook: POST of the neutral message, versioned, with its headers', async () => {
    const { transports, calls } = fakeTransports();
    await getNotificationChannel('webhook', transports).send(
      { config: { url: 'https://hook.example.test/in' }, secrets: { token: 'jeton-tres-secret' } },
      message,
    );

    assert.equal(calls.length, 1);
    const call = calls[0]!;
    assert.equal(call.url, 'https://hook.example.test/in');
    assert.equal(call.init.method, 'POST');
    const headers = call.init.headers as Record<string, string>;
    assert.equal(headers.authorization, 'Bearer jeton-tres-secret');
    assert.equal(headers['X-Control-Plane-Event'], 'deployment.scan_blocked');
    assert.equal(headers['X-Control-Plane-Severity'], 'critical');

    const payload = body(call);
    assert.equal(payload.version, 1);
    assert.equal(payload.event, 'deployment.scan_blocked');
    assert.equal(payload.instance, 'Panel de recette');
  });

  it('discord: a colored embed, and a probe that posts nothing', async () => {
    const { transports, calls } = fakeTransports(() => new Response('{"name":"ops"}', { status: 200 }));
    const url = 'https://discord.com/api/webhooks/1/abcdefghijklmnop';

    const probe = await getNotificationChannel('discord', transports).test({
      config: {},
      secrets: { webhookUrl: url },
    });
    assert.equal(probe.ok, true);
    assert.equal(calls[0]?.init.method, 'GET');

    await getNotificationChannel('discord', transports).send(
      { config: { username: 'Control plane' }, secrets: { webhookUrl: url } },
      message,
    );

    const payload = body(calls[1]!);
    const embeds = payload.embeds as { title: string; color: number; fields: unknown[] }[];
    assert.equal(payload.username, 'Control plane');
    assert.equal(embeds[0]?.color, 0xc0392b);
    assert.ok(embeds[0]?.title.includes('analyse de sécurité'));
    assert.ok(Array.isArray(embeds[0]?.fields));
  });

  it('telegram: escaped MarkdownV2, and the call to the right endpoint', async () => {
    const { transports, calls } = fakeTransports();
    await getNotificationChannel('telegram', transports).send(
      {
        config: { chatId: '-100123', apiBaseUrl: 'http://127.0.0.1:9/' },
        secrets: { botToken: '123456789:AAbbccddeeffgghhiijjkkllmmnnoopp' },
      },
      message,
    );

    const call = calls[0]!;
    assert.equal(call.url, 'http://127.0.0.1:9/bot123456789:AAbbccddeeffgghhiijjkkllmmnnoopp/sendMessage');
    const payload = body(call);
    assert.equal(payload.parse_mode, 'MarkdownV2');
    assert.equal(payload.chat_id, '-100123');

    const text = String(payload.text);
    // The period, the dash and the parenthesis are reserved: unescaped, Telegram
    // refuses the whole message with a "can't parse entities".
    assert.ok(text.includes('\\.'), 'the period must be escaped');
    assert.ok(text.includes('\\-') || !message.body.includes('-'));
    // The link stays usable: only its label is escaped.
    assert.ok(text.includes('](https://panel.example.test/deployments/'));
  });

  it('telegram: escaping covers the eighteen reserved characters', () => {
    assert.equal(escapeMarkdownV2('a.b-c(d)!'), 'a\\.b\\-c\\(d\\)\\!');
    assert.equal(escapeMarkdownV2('100% sûr'), '100% sûr');
  });

  it('smtp: text and HTML, prefixed subject, separate recipients', async () => {
    const { transports, mails } = fakeTransports();
    const resolved = {
      config: {
        host: 'smtp.example.test',
        port: 465,
        security: 'implicit',
        user: 'panel',
        from: 'Control plane <panel@example.test>',
        to: 'ops@example.test, astreinte@example.test',
        rejectUnauthorized: true,
      },
      secrets: { password: 'mot-de-passe-smtp' },
    };

    const probe = await getNotificationChannel('smtp', transports).test(resolved);
    assert.equal(probe.ok, true);
    assert.equal(mails.verified, 1);
    // Implicit SMTPS: the session opens encrypted, STARTTLS is not required.
    assert.equal(mails.options.secure, true);
    assert.equal(mails.options.requireTls, false);
    assert.deepEqual(mails.options.auth, { user: 'panel', pass: 'mot-de-passe-smtp' });

    await getNotificationChannel('smtp', transports).send(resolved, message);
    const envelope = mails.envelopes[0]!;
    assert.deepEqual(envelope.to, ['ops@example.test', 'astreinte@example.test']);
    assert.ok(envelope.subject.startsWith('[Panel de recette] '));
    assert.ok(envelope.html.includes('<html'));
    assert.ok(!envelope.text.includes('<'));
    assert.equal(envelope.headers['X-Control-Plane-Event'], 'deployment.scan_blocked');
    // The tile travels with the message: the HTML cites it by `cid:`, never by URL.
    const [mark] = envelope.inlineImages ?? [];
    assert.ok(mark, 'the Pupitre tile is not attached');
    assert.ok(envelope.html.includes(`src="cid:${mark.cid}"`));
    assert.ok(!/<img[^>]+src="https?:/.test(envelope.html), 'a remote image slipped in');
  });

  it('smtp: STARTTLS is required, never opportunistic', async () => {
    const { transports, mails } = fakeTransports();
    await getNotificationChannel('smtp', transports).test({
      config: { host: 'smtp.example.test', port: 587, security: 'starttls', from: 'a@b.test', to: 'c@d.test' },
      secrets: {},
    });
    assert.equal(mails.options.secure, false);
    assert.equal(mails.options.requireTls, true);
    // No credentials: no authentication, rather than an empty authentication.
    assert.equal(mails.options.auth, null);
  });
});

describe('notifications — secrets do not leak through error messages', () => {
  it('masks the exact value, the Telegram token and a Discord webhook’s token', () => {
    const token = '123456789:AAbbccddeeffgghhiijjkkllmmnnoopp';
    assert.ok(!redactSecrets(`échec sur ${token}`).includes(token));
    assert.equal(
      redactSecrets('https://discord.com/api/webhooks/42/tres-long-jeton-ici'),
      'https://discord.com/api/webhooks/42/[secret masqué]',
    );
    assert.ok(!redactSecrets('refusé : sekret-de-la-mort', { token: 'sekret-de-la-mort' }).includes('sekret'));
    assert.ok(!redactSecrets('Authorization: Bearer abcdefghijklmnop').includes('abcdefghij'));
  });

  it('unfolds the cause: “fetch failed” alone does not make the failure visible', () => {
    const wrapped = new TypeError('fetch failed', {
      cause: new Error('connect ECONNREFUSED 127.0.0.1:9'),
    });
    assert.equal(
      describeFailure(wrapped),
      'fetch failed : connect ECONNREFUSED 127.0.0.1:9',
    );
  });

  it('a 401 that copies the token does not report it as is', async () => {
    const token = '987654321:ZZyyxxwwvvuuttssrrqqppoonnmmllkk';
    const { transports } = fakeTransports(
      () => new Response(`{"description":"Unauthorized for bot${token}"}`, { status: 401 }),
    );

    await assert.rejects(
      getNotificationChannel('telegram', transports).send(
        { config: { chatId: '1', apiBaseUrl: 'http://127.0.0.1:9' }, secrets: { botToken: token } },
        buildNotificationMessage('security.role_changed', entry({ action: 'user.role.changed' }), CTX),
      ),
      (error: Error) => {
        assert.ok(!error.message.includes(token), error.message);
        assert.ok(error.message.includes('[secret masqué]'), error.message);
        return true;
      },
    );
  });
});

/**
 * Site monitoring in the catalog.
 *
 * What is checked here is not "the message is pretty" but "the digest line
 * names the object". A digest of twelve outages that says "12 alerts" has lost
 * the information; the one that says "shop site — unreachable" has kept it. It
 * is the only thing the rest of the layer cannot make up for.
 */
describe('notifications — the monitoring probes', () => {
  function monitorEntry(overrides: Partial<NotifiableAuditEntry> = {}): NotifiableAuditEntry {
    return {
      action: 'monitor.down',
      resourceType: 'monitor',
      resourceId: '22222222-2222-2222-2222-222222222222',
      actorId: null,
      before: { status: 'healthy' },
      after: {
        status: 'unreachable',
        name: 'boutique',
        type: 'http',
        target: 'https://boutique.example.test/',
        incidentId: '33333333-3333-3333-3333-333333333333',
        startedAt: '2026-09-11T09:56:00.000Z',
        resolvedAt: null,
        durationSeconds: null,
        detail: 'connexion refusée',
        metrics: {},
        consecutiveFailures: 3,
      },
      ...overrides,
    };
  }

  it('recognizes the outage and the recovery', () => {
    assert.equal(notifiableEventFor(monitorEntry()), 'monitor.down');
    assert.equal(
      notifiableEventFor(monitorEntry({ action: 'monitor.recovered' })),
      'monitor.recovered',
    );
  });

  it('does not listen to monitoring’s neighboring actions', () => {
    // A probe created, changed or deleted is not an incident. And an isolated
    // measurement writes no entry: the hysteresis is upstream.
    for (const action of ['monitor.created', 'monitor.updated', 'monitor.deleted']) {
      assert.equal(notifiableEventFor(monitorEntry({ action })), null, action);
    }
  });

  it('the digest line names the site and says the nature of the outage', () => {
    const item = buildNotificationDigestItem('monitor.down', monitorEntry(), CTX);
    assert.equal(item.label, 'site boutique — https://boutique.example.test/');
    assert.equal(item.detail, 'injoignable — connexion refusée');
    assert.equal(item.url, 'https://panel.example.test/monitors/22222222-2222-2222-2222-222222222222');
  });

  it('“answers badly” and “unreachable” are not said the same, but group the same', () => {
    const entry503 = monitorEntry({
      after: { ...(monitorEntry().after as object), status: 'unhealthy', detail: 'HTTP 503' },
    });
    assert.equal(notifiableEventFor(entry503), 'monitor.down');
    assert.equal(
      buildNotificationDigestItem('monitor.down', entry503, CTX).detail,
      'répond mal — HTTP 503',
    );
  });

  it('the recovery says the outage’s duration, not a counter', () => {
    const recovered = monitorEntry({
      action: 'monitor.recovered',
      before: { status: 'unreachable' },
      after: {
        ...(monitorEntry().after as object),
        status: 'healthy',
        resolvedAt: '2026-09-11T10:00:00.000Z',
        durationSeconds: 240,
      },
    });
    const item = buildNotificationDigestItem('monitor.recovered', recovered, CTX);
    assert.equal(item.detail, 'rétabli après 4 min de panne');

    const message = buildNotificationMessage('monitor.recovered', recovered, CTX);
    assert.equal(message.severity, 'info');
    assert.ok(message.body.includes('4 min'), message.body);
  });

  it('an oversized URL is truncated, never rejected — otherwise the alert would be lost', () => {
    // `monitorUrlSchema` accepts 2,048 characters; `label` caps at 200. A `parse()`
    // that throws here would fail the delivery and nobody would be warned of the
    // outage.
    const long = monitorEntry({
      after: {
        ...(monitorEntry().after as object),
        target: `https://example.test/${'x'.repeat(2000)}`,
      },
    });
    const item = buildNotificationDigestItem('monitor.down', long, CTX);
    assert.equal(item.label.length, 200);
    assert.ok(item.label.endsWith('…'));
  });

  it('a truncated audit payload does not fail the composition', () => {
    const broken = monitorEntry({ before: null, after: { status: 'unreachable' } });
    const message = buildNotificationMessage('monitor.down', broken, CTX);
    assert.equal(message.severity, 'critical');
    assert.ok(message.title.length > 0);
    const item = buildNotificationDigestItem('monitor.down', broken, CTX);
    assert.ok(item.label.length > 0);
  });
  /*
   * The flaw this block locks: the delivery's deduplication is keyed on (event,
   * resource) for five minutes. For a deployment the resource changes each time;
   * for a probe, it does not — it is the probe. Two distinct outages of the same
   * site close together were therefore merged, and the second alert disappeared
   * without a trace. A deduplication that loses an alert is worse than the
   * duplicate it avoided.
   */
  it('two distinct outages of the same site do not hide each other', () => {
    const premiere = monitorEntry();
    const seconde = monitorEntry({
      after: {
        ...(monitorEntry().after as Record<string, unknown>),
        incidentId: '44444444-4444-4444-4444-444444444444',
      },
    });

    const cle = (entry: NotifiableAuditEntry) =>
      notificationDedupKey(
        'monitor.down',
        entry.resourceId,
        notificationDedupDiscriminator('monitor.down', entry),
      );

    assert.notEqual(cle(premiere), cle(seconde));
  });

  it('the same incident replayed by BullMQ stays absorbed', () => {
    // A replay copies the payload as is: same incident, same key.
    const entry = monitorEntry();
    const rejeu = monitorEntry();
    const cle = (e: NotifiableAuditEntry) =>
      notificationDedupKey('monitor.down', e.resourceId, notificationDedupDiscriminator('monitor.down', e));
    assert.equal(cle(entry), cle(rejeu));
  });

  it('an event without a discriminant keeps the original key', () => {
    // The five deployment and security events do not provide one: their resource
    // is enough, and their key must not change shape.
    assert.equal(notificationDedupKey('deployment.failed', 'abc'), 'deployment.failed|abc');
    assert.equal(notificationDedupKey('deployment.failed', null), 'deployment.failed|none');
  });

});
