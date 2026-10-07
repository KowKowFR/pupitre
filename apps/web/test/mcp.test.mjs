import { strict as assert } from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * The MCP endpoint: its envelope, the way it finds a route, and above all the
 * rule that keeps it honest — a tool is the REST route it names, with the
 * permission that route requires. The route decides; the tool only describes.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.join(here, '..');
const apiRoot = path.join(webRoot, 'src', 'app', 'api');

const protocol = await import('../src/lib/mcp/protocol.ts');
const { createRouter } = await import('../src/lib/mcp/router.ts');
const { TOOLS, visibleTools, formatResponse } = await import('../src/lib/mcp/tools.ts');
const { handleMessage } = await import('../src/lib/mcp/server.ts');
const { EXCLUDED_ROUTES, apiPatterns, renderTable } = await import('../scripts/route-table.mjs');

describe('MCP — the envelope', () => {
  it('sorts requests, notifications, responses and the rest', () => {
    assert.deepEqual(protocol.readMessage({ jsonrpc: '2.0', id: 1, method: 'ping' }), {
      kind: 'request',
      id: 1,
      method: 'ping',
      params: {},
    });
    assert.equal(protocol.readMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }).kind, 'notification');
    assert.equal(protocol.readMessage({ jsonrpc: '2.0', id: 'a', result: {} }).kind, 'response');
    assert.deepEqual(protocol.readMessage({ id: 7, method: 'ping' }), { kind: 'invalid', id: 7 });
    assert.deepEqual(protocol.readMessage('nope'), { kind: 'invalid', id: null });
  });

  it("answers the client's revision when it knows it, its own otherwise", () => {
    assert.equal(protocol.negotiateProtocolVersion('2025-06-18'), '2025-06-18');
    assert.equal(protocol.negotiateProtocolVersion('1999-01-01'), protocol.LATEST_PROTOCOL_VERSION);
    assert.equal(protocol.negotiateProtocolVersion(undefined), protocol.LATEST_PROTOCOL_VERSION);
  });

  it('cuts a text too long for a context, and says so', () => {
    const result = protocol.textResult('x'.repeat(protocol.MAX_TOOL_TEXT + 10));
    assert.match(result.content[0].text, /truncated: 10 more characters/);
    assert.equal(protocol.textResult('ok', true).isError, true);
  });
});

describe('MCP — finding the route', () => {
  const route = createRouter([
    '/api/deployments',
    '/api/deployments/[id]',
    '/api/deployments/purge',
    '/api/targets/[id]/workloads/[ref]/control',
  ]);

  it('prefers a static segment, as Next does', () => {
    assert.deepEqual(route('/api/deployments/purge'), { pattern: '/api/deployments/purge', params: {} });
    assert.deepEqual(route('/api/deployments/4f2c'), {
      pattern: '/api/deployments/[id]',
      params: { id: '4f2c' },
    });
  });

  it('decodes the parameters, and matches nothing more or less', () => {
    assert.deepEqual(route('/api/targets/t1/workloads/docker%3Aweb/control').params, {
      id: 't1',
      ref: 'docker:web',
    });
    assert.equal(route('/api/deployments/a/b'), null);
    assert.equal(route('/api/elsewhere'), null);
    assert.equal(route('/api/targets/t1/workloads/%E0/control'), null);
  });

  it('refuses a catch-all — the only one is Better Auth', () => {
    assert.throws(() => createRouter(['/api/auth/[...all]']), /catch-all/);
  });
});

describe('MCP — the route table', () => {
  it('matches src/app/api exactly — otherwise: pnpm --filter @pupitre/web routes:table', () => {
    const written = readFileSync(path.join(webRoot, 'src/lib/mcp/route-table.ts'), 'utf8');
    assert.equal(written, renderTable(), 'run pnpm --filter @pupitre/web routes:table');
  });

  it('only sets aside routes that exist', () => {
    const patterns = new Set(apiPatterns());
    for (const excluded of Object.keys(EXCLUDED_ROUTES)) assert.ok(patterns.has(excluded), excluded);
  });
});

function routeFile(pattern) {
  return path.join(apiRoot, pattern.replace(/^\/api\/?/, ''), 'route.ts');
}

/** The route's source, and the local modules it imports (`../lifecycle`). */
function routeSources(pattern) {
  const file = routeFile(pattern);
  const source = readFileSync(file, 'utf8');
  const local = [...source.matchAll(/from '(\.{1,2}\/[^']+)'/g)].map((match) =>
    path.resolve(path.dirname(file), `${match[1]}.ts`),
  );
  return [source, ...local.filter(existsSync).map((other) => readFileSync(other, 'utf8'))].join('\n');
}

describe('MCP — each tool is its route', () => {
  const names = TOOLS.map((tool) => tool.name);

  it('names each tool once, in the shape clients accept', () => {
    assert.equal(new Set(names).size, names.length);
    for (const name of names) assert.match(name, /^[a-z][a-z0-9_]{0,63}$/, name);
  });

  it('calls a route that exists, with a method it exports', () => {
    for (const tool of TOOLS.filter((candidate) => candidate.route)) {
      const file = routeFile(tool.route.pattern);
      assert.ok(existsSync(file), `${tool.name}: no route at ${tool.route.pattern}`);
      assert.match(
        readFileSync(file, 'utf8'),
        new RegExp(`export (const|async function) ${tool.route.method}\\b`),
        `${tool.name}: ${tool.route.pattern} does not export ${tool.route.method}`,
      );
    }
  });

  it('declares the permission its route requires', () => {
    for (const tool of TOOLS.filter((candidate) => candidate.route)) {
      const sources = routeSources(tool.route.pattern);
      if (tool.permission === null) {
        assert.match(sources, /requireCaller\(request/, `${tool.name}: the route requires a permission`);
        continue;
      }
      assert.ok(
        sources.includes(`requirePermission(request, '${tool.permission}'`),
        `${tool.name}: ${tool.route.pattern} does not require ${tool.permission}`,
      );
    }
  });

  it('only says "limited token accepted" where the route says it', () => {
    for (const tool of TOOLS.filter((candidate) => candidate.route)) {
      const scoped = readFileSync(routeFile(tool.route.pattern), 'utf8').includes('applicationScoped: true');
      if (tool.applicationScoped) assert.ok(scoped, `${tool.name}: the route refuses a limited token`);
    }
  });

  it('describes its arguments as a JSON Schema', async () => {
    const { z } = await import('zod');
    for (const tool of TOOLS) {
      const schema = z.toJSONSchema(tool.input, { io: 'input', unrepresentable: 'any' });
      assert.equal(schema.type, 'object', tool.name);
      assert.ok(tool.description.length > 20, `${tool.name}: say what it does`);
    }
  });
});

/** A caller holding some permissions, possibly through a limited token. */
function caller(permissions, { applications = null } = {}) {
  const held = new Set(permissions);
  return {
    userId: 'u1',
    can: (permission) => held.has(permission),
    token: { id: 't1', name: 'agent', applications: applications ? new Set(applications) : null },
  };
}

/** A fake API: records the calls, answers what it is told. */
function fakeApi(answer = () => ({ kind: 'json', status: 200, body: { ok: true } })) {
  const calls = [];
  return {
    calls,
    call: async (call) => {
      calls.push(call);
      return answer(call);
    },
  };
}

function context(auth, api = fakeApi()) {
  return { auth, language: 'en', origin: 'https://pupitre.example.com', call: api.call };
}

const tool = (name) => TOOLS.find((candidate) => candidate.name === name);

describe('MCP — what a caller is offered', () => {
  it('only the tools whose permission it holds, plus those that need none', () => {
    const names = visibleTools(caller(['deployment:read'])).map((candidate) => candidate.name);
    assert.ok(names.includes('deployments_list'));
    assert.ok(names.includes('whoami') && names.includes('docs') && names.includes('api_request'));
    assert.ok(!names.includes('deploy'));
    assert.ok(!names.includes('targets_list'));
  });

  it('with a token limited to applications, only the tools its routes accept', () => {
    const names = visibleTools(
      caller(['deployment:read', 'deployment:create', 'target:read'], { applications: ['a1'] }),
    ).map((candidate) => candidate.name);
    assert.ok(names.includes('deploy') && names.includes('deployment_get'));
    assert.ok(!names.includes('targets_list'));
    assert.ok(!names.includes('deployments_list'));
  });
});

describe('MCP — a typed tool builds the request of its route', () => {
  it('puts the path parameters in the path, the rest in the body', async () => {
    const api = fakeApi(() => ({ kind: 'json', status: 202, body: { id: 'd1' } }));
    const result = await tool('deploy').run(
      { applicationId: 'a1', targetId: 't1', runtime: 'docker', images: { web: 'nginx:1.27' } },
      context(caller(['deployment:create']), api),
    );
    assert.deepEqual(api.calls, [
      {
        method: 'POST',
        path: '/api/deployments',
        body: { applicationId: 'a1', targetId: 't1', runtime: 'docker', images: { web: 'nginx:1.27' } },
      },
    ]);
    assert.match(result.content[0].text, /202 Accepted/);
  });

  it('puts the rest in the query string for a read, and encodes the path', async () => {
    const api = fakeApi();
    await tool('workload_control').run(
      { id: 't1', ref: 'docker:web/1', action: 'restart' },
      context(caller(['workload:manage']), api),
    );
    await tool('deployments_list').run({ status: 'failed', page: 2 }, context(caller([]), api));
    assert.deepEqual(api.calls, [
      { method: 'POST', path: '/api/targets/t1/workloads/docker%3Aweb%2F1/control', body: { action: 'restart' } },
      { method: 'GET', path: '/api/deployments', query: { status: 'failed', page: 2 } },
    ]);
  });

  it('sends the AppSpec itself to the validation, and a secret by value or generated', async () => {
    const api = fakeApi();
    await tool('appspec_validate').run({ appSpec: { name: 'blog' } }, context(caller([]), api));
    await tool('application_secret_set').run({ id: 'a1', name: 'API_KEY', generate: true }, context(caller([]), api));
    assert.deepEqual(api.calls[0].body, { name: 'blog' });
    assert.deepEqual(api.calls[1], {
      method: 'PUT',
      path: '/api/applications/a1/secrets/API_KEY',
      body: { generate: true },
    });
  });

  it('turns a refusal into a tool error the agent can read', () => {
    const result = formatResponse(
      {
        kind: 'json',
        status: 403,
        body: { error: { code: 'forbidden', message: 'Permission “deployment:create” required', details: { permission: 'deployment:create' } } },
      },
      { method: 'POST', path: '/api/deployments' },
    );
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /^HTTP 403 forbidden: Permission/);
    assert.match(result.content[0].text, /"permission": "deployment:create"/);
  });

  it('says how to read a log rather than hanging on a stream', () => {
    const result = formatResponse({ kind: 'stream', status: 200 }, { method: 'GET', path: '/api/deployments/d1/logs' });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /logs\/export/);
  });

  it('keeps the tail of a deployment log', async () => {
    const api = fakeApi(() => ({
      kind: 'text',
      status: 200,
      contentType: 'text/plain',
      body: ['one', 'two', 'three', 'four'].join('\n'),
    }));
    const result = await tool('deployment_logs').run({ id: 'd1', tail: 2 }, context(caller([]), api));
    assert.equal(result.content[0].text, '[2 earlier lines skipped]\nthree\nfour');
    assert.deepEqual(api.calls[0].query, { format: 'text' });
  });

  it('waits for a deployment until it is over', async () => {
    const states = ['running', 'success'];
    const api = fakeApi(() => ({ kind: 'json', status: 200, body: { id: 'd1', status: states.shift() } }));
    const result = await tool('deployment_wait').run({ id: 'd1', timeoutSeconds: 10 }, context(caller([]), api));
    assert.equal(api.calls.length, 2);
    assert.match(result.content[0].text, /"status": "success"/);
  });

  it('the generic tool passes method, path, query and body through', async () => {
    const api = fakeApi();
    await tool('api_request').run(
      { method: 'PATCH', path: '/api/monitors/m1', body: { enabled: false } },
      context(caller([]), api),
    );
    assert.deepEqual(api.calls, [{ method: 'PATCH', path: '/api/monitors/m1', body: { enabled: false } }]);
  });
});

describe('MCP — a conversation', () => {
  const ctx = (permissions = ['deployment:read']) => context(caller(permissions));

  it('initializes, then lists what the token can use', async () => {
    const init = await handleMessage(
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
      ctx(),
    );
    assert.equal(init.result.protocolVersion, '2025-06-18');
    assert.equal(init.result.serverInfo.name, 'pupitre');
    assert.ok(init.result.capabilities.tools);

    assert.equal(await handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, ctx()), null);

    const list = await handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, ctx());
    const names = list.result.tools.map((candidate) => candidate.name);
    assert.ok(names.includes('deployment_get'));
    assert.ok(!names.includes('deploy'));
    const get = list.result.tools.find((candidate) => candidate.name === 'deployment_get');
    assert.deepEqual(get.inputSchema.required, ['id']);
    assert.equal(get.annotations.readOnlyHint, true);
  });

  it('reports bad arguments as a tool error, an unknown tool as a protocol error', async () => {
    const bad = await handleMessage(
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'deployment_get', arguments: { id: 'x' } } },
      ctx(),
    );
    assert.equal(bad.result.isError, true);
    assert.match(bad.result.content[0].text, /Invalid arguments for deployment_get/);

    const unknown = await handleMessage(
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'rm_rf', arguments: {} } },
      ctx(),
    );
    assert.equal(unknown.error.code, protocol.JSON_RPC_ERRORS.invalidParams);

    const missing = await handleMessage({ jsonrpc: '2.0', id: 5, method: 'nope' }, ctx());
    assert.equal(missing.error.code, protocol.JSON_RPC_ERRORS.methodNotFound);
  });

  it('a tool that throws fails as a tool, and is reported', async () => {
    const events = [];
    const failing = {
      ...ctx(),
      call: async () => {
        throw new Error('boom');
      },
      onToolCall: (event) => events.push(event),
    };
    const result = await handleMessage(
      { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'running_apps', arguments: {} } },
      failing,
    );
    assert.equal(result.result.isError, true);
    assert.equal(events.length, 1);
    assert.equal(events[0].tool, 'running_apps');
    assert.equal(events[0].isError, true);
    assert.ok(events[0].error instanceof Error);
  });
});

const { secureTransport, isLoopbackHost } = await import('../src/lib/secure-transport.ts');

describe('MCP — HTTPS only', () => {
  const request = (url, headers = {}) => ({ url, headers: new Headers(headers) });

  it('accepts HTTPS, direct or terminated by a reverse proxy', () => {
    assert.equal(secureTransport(request('https://pupitre.example.com/api/mcp')), 'https');
    assert.equal(
      secureTransport(request('http://10.0.0.5:3000/api/mcp', { 'x-forwarded-proto': 'https', host: 'pupitre.example.com' })),
      'https',
    );
    assert.equal(
      secureTransport(request('http://10.0.0.5:3000/api/mcp', { forwarded: 'for=1.2.3.4;proto=https;host=pupitre.example.com' })),
      'https',
    );
    assert.equal(secureTransport(request('http://x/api/mcp', { 'x-forwarded-proto': 'https, http' })), 'https');
  });

  it('accepts the machine itself — development, an SSH tunnel', () => {
    assert.equal(secureTransport(request('http://localhost:3000/api/mcp', { host: 'localhost:3000' })), 'loopback');
    assert.equal(secureTransport(request('http://127.0.0.1:3000/api/mcp', { host: '127.0.0.1:3000' })), 'loopback');
    assert.equal(secureTransport(request('http://[::1]:3000/api/mcp', { host: '[::1]:3000' })), 'loopback');
    assert.ok(isLoopbackHost('pupitre.localhost'));
  });

  it('refuses plain HTTP from anywhere else', () => {
    assert.equal(secureTransport(request('http://141.94.33.212:3000/api/mcp', { host: '141.94.33.212:3000' })), null);
    assert.equal(
      secureTransport(request('http://10.0.0.5:3000/api/mcp', { 'x-forwarded-proto': 'http', host: 'pupitre.example.com' })),
      null,
    );
    assert.equal(secureTransport(request('http://localhost.example.com/api/mcp', { host: 'localhost.example.com' })), null);
    assert.ok(!isLoopbackHost('127.0.0.1.example.com'));
  });

  it('the route checks it before anything else', () => {
    const source = readFileSync(path.join(apiRoot, 'mcp', 'route.ts'), 'utf8');
    const guard = source.indexOf('secureTransport(request)');
    assert.ok(guard > 0, 'the MCP route checks the transport');
    assert.ok(guard < source.indexOf('requireCaller(request'), 'before authenticating');
  });
});
