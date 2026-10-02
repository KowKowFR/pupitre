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
 * Tout est vérifié **sans réseau** : les transports sont injectés. C'est la
 * raison d'être de `NotificationTransports` — un canal ne doit pas exiger un
 * serveur SMTP, un jeton Telegram et un salon Discord pour être testable.
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
  // La langue est un réglage d'instance : le worker la résout et la descend ici.
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

describe('notifications — la table des événements', () => {
  it('reconnaît les cinq événements retenus', () => {
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

  it('ignore tout le reste — c’est ce qui tient le volume', () => {
    for (const action of [
      'deployment.created',
      'permission.denied',
      'auth.logout',
      'settings.updated',
      'target.preflight.completed',
      // Anti-boucle : prévenir qu'on n'a pas su prévenir relancerait la
      // distribution sur elle-même.
      'notification.delivery.failed',
    ]) {
      assert.equal(notifiableEventFor(entry({ action })), null, action);
    }
  });

  it('une inscription publique prévient, un compte créé par un administrateur non', () => {
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

  it('un déploiement réussi se nomme : application, version, machine, URL', () => {
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

  it('une machine injoignable prévient, et son retour dit la durée', () => {
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

  it('un certificat bientôt échu prévient, son renouvellement aussi', () => {
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

  it('un jeton d’API créé prévient, sans jamais porter le jeton', () => {
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

  it('une clé d’hôte inattendue sur une cible prévient, et nomme les deux clés', () => {
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
    // Accepter ou écarter une clé est un geste, pas une alerte.
    assert.equal(notifiableEventFor(entry({ action: 'target.host_key.accepted' })), null);
    assert.equal(notifiableEventFor(entry({ action: 'target.host_key.recorded' })), null);
  });

  it('un rollback manuel n’est pas un rollback automatique', () => {
    assert.equal(notifiableEventFor(entry({ action: 'deployment.rolled_back' })), null);
  });

  it('compose un message neutre valide, lien du panel compris', () => {
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
    // Le message neutre ne porte aucun balisage : ni HTML, ni Markdown.
    assert.ok(!/[<>*`]/.test(message.body));
  });

  it('survit à une charge utile d’audit difforme', () => {
    const message = buildNotificationMessage(
      'security.role_changed',
      entry({ action: 'user.role.changed', after: 'pas un objet', before: null }),
      { ...CTX, actor: null },
    );
    notificationMessageSchema.parse(message);
  });

  it('rend un texte brut lisible', () => {
    const text = renderPlainText(
      buildNotificationMessage('deployment.failed', entry({ after: { error: 'boum' } }), CTX),
    );
    assert.ok(text.includes('Déploiement en échec'));
    assert.ok(text.includes('https://panel.example.test/deployments/'));
  });
});

describe('notifications — le catalogue', () => {
  it('refuse une configuration à laquelle il manque un champ obligatoire', () => {
    assert.throws(() => channelConfigSchema('smtp').parse({ from: 'a@b.test', to: 'c@d.test' }));
    assert.throws(() => channelConfigSchema('webhook').parse({}));
    // Une URL qui n'en est pas une ne doit pas non plus passer.
    assert.throws(() => channelConfigSchema('webhook').parse({ url: 'pas-une-url' }));
  });

  it('applique les valeurs par défaut déclarées', () => {
    const parsed = channelConfigSchema('smtp').parse({
      host: 'smtp.example.test',
      from: 'panel@example.test',
      to: 'ops@example.test',
    }) as Record<string, unknown>;
    assert.equal(parsed.port, 587);
    assert.equal(parsed.security, 'starttls');
    assert.equal(parsed.rejectUnauthorized, true);
  });

  it('désigne les champs secrets, et le catalogue présenté ne porte aucun schéma', () => {
    assert.deepEqual(channelSecretFields('telegram'), ['botToken']);
    assert.deepEqual(channelSecretFields('discord'), ['webhookUrl']);
    // Sérialisable : une `RegExp` ou une fonction deviendrait `{}` en JSON, et
    // l'écran afficherait un formulaire vide sans la moindre erreur.
    const presented = presentNotificationChannels();
    assert.deepEqual(JSON.parse(JSON.stringify(presented)), presented);
    assert.ok(presented.every((channel) => channel.fields.every((f) => !('schema' in f))));
  });
});

describe('notifications — les canaux', () => {
  const message = buildNotificationMessage(
    'deployment.scan_blocked',
    entry({ after: { failedStep: 'scan', error: 'CVE-2026-1 (CRITICAL)' } }),
    CTX,
  );

  it('webhook : POST du message neutre, versionné, avec ses en-têtes', async () => {
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

  it('discord : un embed coloré, et une sonde qui ne dépose rien', async () => {
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

  it('telegram : MarkdownV2 échappé, et l’appel au bon point d’entrée', async () => {
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
    // Le point, le tiret et la parenthèse sont réservés : non échappés, Telegram
    // refuse le message entier avec un « can't parse entities ».
    assert.ok(text.includes('\\.'), 'le point doit être échappé');
    assert.ok(text.includes('\\-') || !message.body.includes('-'));
    // Le lien reste exploitable : seul son libellé est échappé.
    assert.ok(text.includes('](https://panel.example.test/deployments/'));
  });

  it('telegram : l’échappement couvre les dix-huit caractères réservés', () => {
    assert.equal(escapeMarkdownV2('a.b-c(d)!'), 'a\\.b\\-c\\(d\\)\\!');
    assert.equal(escapeMarkdownV2('100% sûr'), '100% sûr');
  });

  it('smtp : texte et HTML, sujet préfixé, destinataires séparés', async () => {
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
    // SMTPS implicite : la session s'ouvre chiffrée, STARTTLS n'est pas exigé.
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
    // La tuile voyage avec le message : le HTML la cite par `cid:`, jamais par URL.
    const [mark] = envelope.inlineImages ?? [];
    assert.ok(mark, 'la tuile Pupitre n’est pas jointe');
    assert.ok(envelope.html.includes(`src="cid:${mark.cid}"`));
    assert.ok(!/<img[^>]+src="https?:/.test(envelope.html), 'une image distante a été glissée');
  });

  it('smtp : STARTTLS est exigé, jamais opportuniste', async () => {
    const { transports, mails } = fakeTransports();
    await getNotificationChannel('smtp', transports).test({
      config: { host: 'smtp.example.test', port: 587, security: 'starttls', from: 'a@b.test', to: 'c@d.test' },
      secrets: {},
    });
    assert.equal(mails.options.secure, false);
    assert.equal(mails.options.requireTls, true);
    // Aucun identifiant : pas d'authentification, plutôt qu’une authentification vide.
    assert.equal(mails.options.auth, null);
  });
});

describe('notifications — les secrets ne fuient pas par les messages d’erreur', () => {
  it('masque la valeur exacte, le jeton Telegram et le jeton d’un webhook Discord', () => {
    const token = '123456789:AAbbccddeeffgghhiijjkkllmmnnoopp';
    assert.ok(!redactSecrets(`échec sur ${token}`).includes(token));
    assert.equal(
      redactSecrets('https://discord.com/api/webhooks/42/tres-long-jeton-ici'),
      'https://discord.com/api/webhooks/42/[secret masqué]',
    );
    assert.ok(!redactSecrets('refusé : sekret-de-la-mort', { token: 'sekret-de-la-mort' }).includes('sekret'));
    assert.ok(!redactSecrets('Authorization: Bearer abcdefghijklmnop').includes('abcdefghij'));
  });

  it('déplie la cause : « fetch failed » tout seul ne rend pas l’échec visible', () => {
    const wrapped = new TypeError('fetch failed', {
      cause: new Error('connect ECONNREFUSED 127.0.0.1:9'),
    });
    assert.equal(
      describeFailure(wrapped),
      'fetch failed : connect ECONNREFUSED 127.0.0.1:9',
    );
  });

  it('un 401 qui recopie le jeton ne le remonte pas tel quel', async () => {
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
 * La supervision de sites au catalogue.
 *
 * Ce qui est vérifié ici n'est pas « le message est joli » mais « la ligne de
 * résumé nomme l'objet ». Un résumé de douze pannes qui dit « 12 alertes » a
 * perdu l'information ; celui qui dit « site boutique — injoignable » l'a
 * gardée. C'est la seule chose que le reste de la couche ne peut pas rattraper.
 */
describe('notifications — les sondes de supervision', () => {
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

  it('reconnaît la panne et le rétablissement', () => {
    assert.equal(notifiableEventFor(monitorEntry()), 'monitor.down');
    assert.equal(
      notifiableEventFor(monitorEntry({ action: 'monitor.recovered' })),
      'monitor.recovered',
    );
  });

  it('n’écoute pas les actions voisines de la supervision', () => {
    // Une sonde créée, modifiée ou supprimée n'est pas un incident. Et une
    // mesure isolée n'écrit aucune entrée : l'hystérésis est en amont.
    for (const action of ['monitor.created', 'monitor.updated', 'monitor.deleted']) {
      assert.equal(notifiableEventFor(monitorEntry({ action })), null, action);
    }
  });

  it('la ligne de résumé nomme le site et dit la nature de la panne', () => {
    const item = buildNotificationDigestItem('monitor.down', monitorEntry(), CTX);
    assert.equal(item.label, 'site boutique — https://boutique.example.test/');
    assert.equal(item.detail, 'injoignable — connexion refusée');
    assert.equal(item.url, 'https://panel.example.test/monitors/22222222-2222-2222-2222-222222222222');
  });

  it('« répond mal » et « injoignable » ne se disent pas pareil, mais se groupent pareil', () => {
    const entry503 = monitorEntry({
      after: { ...(monitorEntry().after as object), status: 'unhealthy', detail: 'HTTP 503' },
    });
    assert.equal(notifiableEventFor(entry503), 'monitor.down');
    assert.equal(
      buildNotificationDigestItem('monitor.down', entry503, CTX).detail,
      'répond mal — HTTP 503',
    );
  });

  it('le rétablissement dit la durée de la panne, pas un compteur', () => {
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

  it('une URL démesurée est tronquée, jamais rejetée — sinon l’alerte serait perdue', () => {
    // `monitorUrlSchema` accepte 2 048 caractères ; `label` en plafonne 200.
    // Un `parse()` qui lève ici ferait échouer la distribution et personne ne
    // serait prévenu de la panne.
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

  it('une charge utile d’audit amputée ne fait pas échouer la composition', () => {
    const broken = monitorEntry({ before: null, after: { status: 'unreachable' } });
    const message = buildNotificationMessage('monitor.down', broken, CTX);
    assert.equal(message.severity, 'critical');
    assert.ok(message.title.length > 0);
    const item = buildNotificationDigestItem('monitor.down', broken, CTX);
    assert.ok(item.label.length > 0);
  });
  /*
   * Le défaut que ce bloc verrouille : l'anti-doublon de la distribution porte
   * sur (événement, ressource) pendant cinq minutes. Pour un déploiement la
   * ressource change à chaque fois ; pour une sonde, non — c'est la sonde. Deux
   * pannes distinctes du même site rapprochées se confondaient donc, et la
   * seconde alerte disparaissait sans trace. Un anti-doublon qui perd une
   * alerte est pire que le doublon qu'il évitait.
   */
  it('deux pannes distinctes du même site ne se masquent pas', () => {
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

  it('le même incident rejoué par BullMQ reste absorbé', () => {
    // Un rejeu recopie la charge utile telle quelle : même incident, même clé.
    const entry = monitorEntry();
    const rejeu = monitorEntry();
    const cle = (e: NotifiableAuditEntry) =>
      notificationDedupKey('monitor.down', e.resourceId, notificationDedupDiscriminator('monitor.down', e));
    assert.equal(cle(entry), cle(rejeu));
  });

  it('un événement sans discriminant garde la clé d’origine', () => {
    // Les cinq événements de déploiement et de sécurité n'en fournissent pas :
    // leur ressource suffit, et leur clé ne doit pas changer de forme.
    assert.equal(notificationDedupKey('deployment.failed', 'abc'), 'deployment.failed|abc');
    assert.equal(notificationDedupKey('deployment.failed', null), 'deployment.failed|none');
  });

});
