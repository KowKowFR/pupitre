import {
  routeInputSchema,
  workloadControlActionSchema,
  type Permission,
  type UiLanguage,
} from '@pupitre/core';
import { z } from 'zod';
import { DOC_CHAPTERS } from '@/lib/docs/chapters';
import { listChapters, readChapter, searchDocs } from '@/lib/docs/content';
import type { AuthContext } from '@/lib/rbac';
import type { ApiCall, ApiResponse, HttpMethod } from './dispatch';
import { textResult, type ToolAnnotations, type ToolResult } from './protocol';

/**
 * The MCP endpoint's tools.
 *
 * ── Two kinds ───────────────────────────────────────────────────────────────
 * Most are **the REST API, typed**: one tool, one route, its arguments described
 * for an agent. They decide nothing — `rest()` builds the request, `callApi()`
 * hands it to the Route Handler, which checks the permission, the scope, the
 * schema, and writes the audit log. `api_request` reaches every other route:
 * "everything the API does, MCP does" holds without a tool per route.
 *
 * ── Why the descriptions are in English ─────────────────────────────────────
 * They are read by a model, not shown to a user — like the routes' paths and
 * the errors' `code`, they are the contract and do not follow the instance's
 * language. What the routes answer does: an error message comes back in the
 * instance's language, as it would to `curl`.
 *
 * `test/mcp.test.mjs` checks that each typed tool's route exists, exports its
 * method and requires the permission the tool declares.
 *
 * Not `server-only`, and nothing here imports a route: the call goes through
 * the context (`ToolContext.call`), so the tests run the tools without a server.
 */

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

export type ToolContext = {
  /** The caller — to list the tools it may use, never to allow them. */
  auth: Pick<AuthContext, 'userId' | 'can' | 'token'>;
  language: UiLanguage;
  origin: string;
  /** A REST route, with the MCP request's token, IP and browser (`callApi()`). */
  call: (call: ApiCall) => Promise<ApiResponse>;
};

export type Tool = {
  name: string;
  title: string;
  description: string;
  input: z.ZodObject<z.ZodRawShape>;
  /**
   * What the tool requires — to list it to a token that holds it, never to allow
   * it: the route decides. `null`: every caller.
   */
  permission: Permission | null;
  /** The route accepts a token limited to some applications. */
  applicationScoped?: boolean;
  annotations: ToolAnnotations;
  /** The route behind the tool, `METHOD /api/pattern` — for the guard test. */
  route?: { method: HttpMethod; pattern: string };
  run: (input: Record<string, unknown>, context: ToolContext) => Promise<ToolResult>;
};

/* ─── Turning a response into what an agent reads ──────────────────────────── */

type ErrorBody = { error?: { code?: unknown; message?: unknown; details?: unknown } };

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function formatResponse(response: ApiResponse, call: ApiCall): ToolResult {
  const label = `${call.method} ${call.path}`;
  switch (response.kind) {
    case 'unknown_route':
      return textResult(
        `No API route at ${call.path}. The routes are listed in the documentation: docs { "chapter": "api" }.`,
        true,
      );
    case 'method_not_allowed':
      return textResult(
        `${call.method} is not allowed on ${call.path}. Allowed: ${response.allowed.join(', ') || 'none'}.`,
        true,
      );
    case 'stream':
      return textResult(
        `${label} is a live stream (Server-Sent Events) that never ends: it cannot be read as one answer. ` +
          'For a deployment, read GET /api/deployments/{id}/logs/export (tool deployment_logs).',
        true,
      );
    case 'binary':
      return textResult(
        `${label} → HTTP ${response.status}, ${response.contentType || 'binary'}, ${response.bytes} bytes — not shown.`,
        response.status >= 400,
      );
    case 'image':
      return {
        content: [
          { type: 'image', data: response.base64, mimeType: response.contentType },
          { type: 'text', text: `${label} → HTTP ${response.status}, ${response.contentType}` },
        ],
        ...(response.status >= 400 ? { isError: true } : {}),
      };
    case 'text':
      return textResult(
        response.status >= 400 ? `HTTP ${response.status}\n${response.body}` : response.body,
        response.status >= 400,
      );
    case 'json': {
      if (response.status >= 400) {
        const error = (response.body as ErrorBody | null)?.error;
        const head = `HTTP ${response.status} ${typeof error?.code === 'string' ? error.code : ''}`.trim();
        const message = typeof error?.message === 'string' ? `: ${error.message}` : '';
        const details = error?.details === undefined ? '' : `\ndetails: ${json(error.details)}`;
        return textResult(`${head}${message}${details}`, true);
      }
      const accepted =
        response.status === 202
          ? 'HTTP 202 Accepted — the work runs in the background, in the worker.\n'
          : '';
      return textResult(
        `${accepted}${response.body === null ? `HTTP ${response.status}, no content.` : json(response.body)}`,
      );
    }
  }
}

/* ─── Typed tools: one route each ──────────────────────────────────────────── */

const uuid = (what: string) => z.string().uuid().describe(what);

function fillPattern(pattern: string, input: Record<string, unknown>): { path: string; used: Set<string> } {
  const used = new Set<string>();
  const path = pattern.replace(/\[([A-Za-z0-9_]+)\]/g, (_, name: string) => {
    used.add(name);
    return encodeURIComponent(String(input[name] ?? ''));
  });
  return { path, used };
}

type RestSpec = {
  name: string;
  title: string;
  description: string;
  method: HttpMethod;
  pattern: string;
  input?: z.ZodObject<z.ZodRawShape>;
  permission: Permission | null;
  applicationScoped?: boolean;
  annotations?: Omit<ToolAnnotations, 'title'>;
  /**
   * The body, from the arguments. By default: the arguments that are not path
   * parameters, for POST, PUT and PATCH.
   */
  body?: (input: Record<string, unknown>) => unknown;
};

function rest(spec: RestSpec): Tool {
  const readOnly = spec.method === 'GET';
  return {
    name: spec.name,
    title: spec.title,
    description: spec.description,
    input: spec.input ?? z.object({}),
    permission: spec.permission,
    ...(spec.applicationScoped ? { applicationScoped: true } : {}),
    annotations: {
      title: spec.title,
      readOnlyHint: readOnly,
      ...(readOnly ? {} : { destructiveHint: false }),
      ...(spec.method === 'PUT' ? { idempotentHint: true } : {}),
      ...spec.annotations,
    },
    route: { method: spec.method, pattern: spec.pattern },
    run: async (input, context) => {
      const { path, used } = fillPattern(spec.pattern, input);
      const rest = Object.fromEntries(Object.entries(input).filter(([key]) => !used.has(key)));
      const call: ApiCall =
        spec.method === 'GET' || spec.method === 'DELETE'
          ? { method: spec.method, path, query: rest as ApiCall['query'] }
          : { method: spec.method, path, body: spec.body ? spec.body(input) : rest };
      return formatResponse(await context.call(call), call);
    },
  };
}

/* ─── The catalog ──────────────────────────────────────────────────────────── */

const DEPLOYMENT_STATUSES = ['pending', 'running', 'success', 'failed', 'rolled_back', 'destroyed'] as const;
const TERMINAL = new Set(['success', 'failed', 'rolled_back', 'destroyed']);

const appSpecArgument = z
  .record(z.string(), z.unknown())
  .describe('An AppSpec object. Its JSON Schema: tool appspec_schema. Check it first with appspec_validate.');

const pageArguments = {
  page: z.number().int().min(1).optional().describe('Page number, from 1.'),
  pageSize: z.number().int().min(1).max(100).optional().describe('Items per page.'),
};

const whoami = rest({
  name: 'whoami',
  title: 'Who am I',
  description:
    'The account this token acts for, its roles, and the permissions the token really has today (what it was given, cut down to what the account still holds). `token.applicationIds` lists the applications it is limited to, null for all. Call it first: it tells which tools will be refused.',
  method: 'GET',
  pattern: '/api/me',
  permission: null,
});

const docs: Tool = {
  name: 'docs',
  title: 'Read the Pupitre documentation',
  description:
    'The documentation of this Pupitre instance — concepts, procedures, examples, the REST API reference, error codes. Without arguments: the table of contents. With `query`: the sections that match. With `chapter`: the whole chapter, in Markdown. Read it before guessing how something works.',
  input: z.object({
    chapter: z
      .enum(DOC_CHAPTERS.map((chapter) => chapter.slug) as [string, ...string[]])
      .optional()
      .describe('A chapter to read in full.'),
    query: z.string().min(2).max(200).optional().describe('Words to look for in every chapter.'),
    language: z
      .enum(['fr', 'en'])
      .optional()
      .describe("The documentation's language. Default: the instance's."),
  }),
  permission: null,
  annotations: { title: 'Read the Pupitre documentation', readOnlyHint: true },
  run: async (input, context) => {
    const language = (input.language as UiLanguage | undefined) ?? context.language;
    if (typeof input.chapter === 'string') {
      return textResult(readChapter(language, input.chapter, context.origin).markdown);
    }
    if (typeof input.query === 'string') {
      const hits = searchDocs(language, input.query, context.origin, 12);
      if (hits.length === 0) return textResult(`Nothing found for "${input.query}". Read the table of contents: docs {}.`);
      return textResult(
        hits
          .map(
            (hit) =>
              `• ${hit.chapter}${hit.section ? ` › ${hit.section.text}` : ''} — docs { "chapter": "${hit.slug}" }\n  ${hit.excerpt}`,
          )
          .join('\n'),
      );
    }
    return textResult(
      listChapters(language, context.origin)
        .map((chapter) => `• ${chapter.slug} — ${chapter.title}: ${chapter.summary}`)
        .join('\n'),
    );
  },
};

const apiRequest: Tool = {
  name: 'api_request',
  title: 'Call any Pupitre API route',
  description: [
    'Calls any route of the Pupitre REST API with this token — what the typed tools do not cover: proxies, monitors, maintenance windows, scheduled jobs, backups, status pages, users and roles, settings, notifications, repositories.',
    'The route checks the permission and records the action in the audit log, exactly as for curl. JSON in, JSON out; a 202 means the work was queued.',
    'The complete list of routes, their bodies and their permissions: docs { "chapter": "api" }.',
    'Live streams (Server-Sent Events) cannot be read here.',
  ].join(' '),
  input: z.object({
    method: z.enum(HTTP_METHODS).describe('HTTP method.'),
    path: z
      .string()
      .regex(/^\/api\//)
      .max(500)
      .describe('The path, from /api/ — e.g. /api/monitors or /api/targets/<id>/proxy.'),
    query: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
      .optional()
      .describe('Query string parameters.'),
    body: z.unknown().optional().describe('JSON body, for POST, PUT and PATCH.'),
  }),
  permission: null,
  annotations: { title: 'Call any Pupitre API route', readOnlyHint: false, destructiveHint: true },
  run: async (input, context) => {
    const call: ApiCall = {
      method: input.method as HttpMethod,
      path: input.path as string,
      ...(input.query ? { query: input.query as ApiCall['query'] } : {}),
      ...(input.body !== undefined ? { body: input.body } : {}),
    };
    return formatResponse(await context.call(call), call);
  },
};

const deploymentWait: Tool = {
  name: 'deployment_wait',
  title: 'Wait for a deployment to finish',
  description:
    'Waits until a deployment leaves pending/running — success, failed, rolled_back or destroyed — then returns it with its steps. Gives up after `timeoutSeconds` and returns the current state: call it again to keep waiting. A deployment takes from a few seconds to several minutes (build on the target, scans).',
  input: z.object({
    id: uuid('The deployment id (returned by deploy, deployment_redeploy, deployment_rollback).'),
    timeoutSeconds: z.number().int().min(1).max(120).optional().describe('At most this long. Default 50.'),
  }),
  permission: 'deployment:read',
  applicationScoped: true,
  annotations: { title: 'Wait for a deployment to finish', readOnlyHint: true },
  route: { method: 'GET', pattern: '/api/deployments/[id]' },
  run: async (input, context) => {
    const deadline = Date.now() + ((input.timeoutSeconds as number | undefined) ?? 50) * 1000;
    const call: ApiCall = { method: 'GET', path: `/api/deployments/${encodeURIComponent(String(input.id))}` };
    for (;;) {
      const response = await context.call(call);
      const status =
        response.kind === 'json' && response.status === 200
          ? (response.body as { status?: unknown } | null)?.status
          : undefined;
      if (typeof status !== 'string' || TERMINAL.has(status) || Date.now() >= deadline) {
        const result = formatResponse(response, call);
        if (typeof status === 'string' && !TERMINAL.has(status)) {
          result.content.unshift({
            type: 'text',
            text: `Still ${status} after the wait — call deployment_wait again, or read deployment_logs.`,
          });
        }
        return result;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(3000, Math.max(0, deadline - Date.now()))));
    }
  },
};

const deploymentLogs: Tool = {
  name: 'deployment_logs',
  title: 'Read a deployment log',
  description:
    "A deployment's log, as text: every step, build output, scan verdicts, healthcheck. `tail` keeps the last lines only — what usually explains a failure.",
  input: z.object({
    id: uuid('The deployment id.'),
    tail: z.number().int().min(1).max(5000).optional().describe('Only the last N lines. Default 300.'),
  }),
  permission: 'deployment:read',
  annotations: { title: 'Read a deployment log', readOnlyHint: true },
  route: { method: 'GET', pattern: '/api/deployments/[id]/logs/export' },
  run: async (input, context) => {
    const call: ApiCall = {
      method: 'GET',
      path: `/api/deployments/${encodeURIComponent(String(input.id))}/logs/export`,
      query: { format: 'text' },
    };
    const response = await context.call(call);
    if (response.kind !== 'text' || response.status >= 400) return formatResponse(response, call);
    const lines = response.body.split('\n');
    const tail = (input.tail as number | undefined) ?? 300;
    const kept = lines.slice(-tail);
    const skipped = lines.length - kept.length;
    return textResult(`${skipped > 0 ? `[${skipped} earlier lines skipped]\n` : ''}${kept.join('\n')}`);
  },
};

export const TOOLS: readonly Tool[] = [
  whoami,
  docs,
  apiRequest,

  // ── AppSpec ────────────────────────────────────────────────────────────────
  rest({
    name: 'appspec_schema',
    title: 'AppSpec JSON Schema',
    description:
      "The JSON Schema of the AppSpec, the neutral description of an application (services, images or builds, ports, volumes, secrets, domain) that Pupitre renders to Docker Compose or Kubernetes. The cross-field rules (exactly one exposed service, no dependsOn cycle…) are checked by appspec_validate.",
    method: 'GET',
    pattern: '/api/appspec/schema',
    permission: null,
  }),
  rest({
    name: 'appspec_validate',
    title: 'Validate an AppSpec',
    description:
      'Validates an AppSpec without creating anything. Returns it as Pupitre stores it (defaults applied), or every problem with its path (services.0.port).',
    method: 'POST',
    pattern: '/api/appspec/validate',
    input: z.object({ appSpec: appSpecArgument }),
    permission: null,
    annotations: { readOnlyHint: true },
    body: (input) => input.appSpec,
  }),

  // ── Targets ────────────────────────────────────────────────────────────────
  rest({
    name: 'targets_list',
    title: 'List targets',
    description:
      'The machines Pupitre deploys to (targets), with their runtimes (docker, k3s), their state and their last preflight. Never their credentials.',
    method: 'GET',
    pattern: '/api/targets',
    permission: 'target:read',
  }),
  rest({
    name: 'target_get',
    title: 'Get a target',
    description: 'One target: address, runtimes available, preflight report, port range, reverse proxy.',
    method: 'GET',
    pattern: '/api/targets/[id]',
    input: z.object({ id: uuid('The target id (targets_list).') }),
    permission: 'target:read',
  }),
  rest({
    name: 'target_preflight',
    title: 'Run a target preflight',
    description:
      'Checks the machine again over SSH — Docker, K3s, disk, ports, firewall — in the background. Read the result with target_get a little later.',
    method: 'POST',
    pattern: '/api/targets/[id]/preflight',
    input: z.object({ id: uuid('The target id.') }),
    permission: 'target:update',
  }),
  rest({
    name: 'target_metrics',
    title: 'Read target metrics',
    description: 'CPU, memory, disk and load of the machine, read now over SSH.',
    method: 'GET',
    pattern: '/api/targets/[id]/metrics',
    input: z.object({ id: uuid('The target id.') }),
    permission: 'target:read',
  }),
  rest({
    name: 'target_ports',
    title: 'Read target ports',
    description: "The target's port range: allocated ports, by which application, and the free ones.",
    method: 'GET',
    pattern: '/api/targets/[id]/ports',
    input: z.object({ id: uuid('The target id.') }),
    permission: 'target:read',
  }),
  rest({
    name: 'target_workloads',
    title: 'List workloads on a target',
    description:
      "Everything that runs on the machine — Pupitre's applications and the containers or workloads it did not install — with their state. A workload's `ref` is what workload_control takes.",
    method: 'GET',
    pattern: '/api/targets/[id]/workloads',
    input: z.object({ id: uuid('The target id.') }),
    permission: 'workload:read',
  }),
  rest({
    name: 'workload_control',
    title: 'Start, stop or restart a workload',
    description: 'Starts, stops or restarts one workload of a target, in the background.',
    method: 'POST',
    pattern: '/api/targets/[id]/workloads/[ref]/control',
    input: z.object({
      id: uuid('The target id.'),
      ref: z.string().min(3).max(320).describe("The workload's ref (target_workloads)."),
      action: workloadControlActionSchema,
    }),
    permission: 'workload:manage',
    annotations: { destructiveHint: true },
  }),

  // ── Applications ───────────────────────────────────────────────────────────
  rest({
    name: 'applications_list',
    title: 'List applications',
    description: 'The applications declared in Pupitre, each with its AppSpec and where it runs.',
    method: 'GET',
    pattern: '/api/applications',
    permission: 'application:read',
  }),
  rest({
    name: 'application_get',
    title: 'Get an application',
    description: 'One application: its AppSpec, its linked repository if any, its deployments by target.',
    method: 'GET',
    pattern: '/api/applications/[id]',
    input: z.object({ id: uuid('The application id (applications_list).') }),
    permission: 'application:read',
    applicationScoped: true,
  }),
  rest({
    name: 'application_create',
    title: 'Create an application',
    description:
      'Creates an application from an AppSpec. Nothing is deployed: call deploy next. Secrets the AppSpec declares get a random value unless given here.',
    method: 'POST',
    pattern: '/api/applications',
    input: z.object({
      appSpec: appSpecArgument,
      description: z.string().max(500).optional().describe('A sentence for the catalog.'),
      secrets: z
        .record(z.string(), z.string())
        .optional()
        .describe('Values for some of the secrets the AppSpec declares, by name.'),
    }),
    permission: 'application:create',
  }),
  rest({
    name: 'application_update',
    title: 'Update an application',
    description:
      "Replaces an application's AppSpec and/or description. Running deployments are not touched: deploy again to apply. Refused for an application whose AppSpec comes from a linked repository — change pupitre.json there.",
    method: 'PATCH',
    pattern: '/api/applications/[id]',
    input: z.object({
      id: uuid('The application id.'),
      appSpec: appSpecArgument.optional(),
      description: z.string().max(500).optional(),
    }),
    permission: 'application:update',
  }),
  rest({
    name: 'application_generate',
    title: 'Draft an AppSpec with the instance AI',
    description:
      "Asks the instance's AI provider to write an AppSpec from a description. Creates nothing: review the result, then application_create. 501 if no AI provider is set up.",
    method: 'POST',
    pattern: '/api/applications/generate',
    input: z.object({
      prompt: z.string().min(8).max(4000).describe('What the application is, what it needs.'),
      hints: z
        .object({
          runtime: z.enum(['docker', 'k3s']).optional(),
          database: z.string().max(60).optional(),
          language: z.string().max(60).optional(),
        })
        .optional(),
    }),
    permission: 'application:create',
  }),
  rest({
    name: 'application_versions',
    title: "List an application's versions",
    description:
      'The versions deployed, newest first — each one a frozen AppSpec that deployment_redeploy can replay, on any target.',
    method: 'GET',
    pattern: '/api/applications/[id]/versions',
    input: z.object({ id: uuid('The application id.') }),
    permission: 'application:read',
  }),
  rest({
    name: 'application_secrets',
    title: "List an application's secrets",
    description: 'The names of the secrets and when they changed — never a value.',
    method: 'GET',
    pattern: '/api/applications/[id]/secrets',
    input: z.object({ id: uuid('The application id.') }),
    permission: 'application:read',
  }),
  rest({
    name: 'application_secret_set',
    title: 'Set a secret',
    description:
      'Sets one secret of an application — a value, or `generate: true` for a random one. It is encrypted at once; the next deployment uses it.',
    method: 'PUT',
    pattern: '/api/applications/[id]/secrets/[name]',
    input: z.object({
      id: uuid('The application id.'),
      name: z.string().min(1).max(128).describe('The secret name, as the AppSpec declares it.'),
      value: z.string().optional().describe('The value. Omit it with generate: true.'),
      generate: z.literal(true).optional().describe('Generate a random value instead.'),
    }),
    permission: 'application:update',
    body: (input) => (input.generate === true ? { generate: true } : { value: input.value }),
  }),
  rest({
    name: 'application_secret_delete',
    title: 'Delete a secret',
    description: 'Deletes one secret value of an application.',
    method: 'DELETE',
    pattern: '/api/applications/[id]/secrets/[name]',
    input: z.object({ id: uuid('The application id.'), name: z.string().min(1).max(128) }),
    permission: 'application:update',
    annotations: { destructiveHint: true },
  }),
  rest({
    name: 'application_domains',
    title: "List an application's domains",
    description: 'The domains of an application, target by target, with their TLS and WAF settings.',
    method: 'GET',
    pattern: '/api/applications/[id]/routes',
    input: z.object({ id: uuid('The application id.') }),
    permission: 'application:read',
  }),
  rest({
    name: 'application_domains_set',
    title: "Replace an application's domains",
    description:
      "Replaces the whole list of an application's domains on one target, and sets them on the reverse proxy at once if the application runs there. A domain is unique across the instance: 409 if another application holds it.",
    method: 'PUT',
    pattern: '/api/applications/[id]/routes',
    input: z.object({
      id: uuid('The application id.'),
      targetId: uuid('The target id.'),
      routes: z.array(routeInputSchema).max(20).describe('The complete list — an empty list removes them all.'),
    }),
    permission: 'deployment:create',
  }),

  // ── Deployments ────────────────────────────────────────────────────────────
  rest({
    name: 'deployments_list',
    title: 'List deployments',
    description: 'Deployment runs, newest first, with filters.',
    method: 'GET',
    pattern: '/api/deployments',
    input: z.object({
      applicationId: uuid('Only this application.').optional(),
      targetId: uuid('Only this target.').optional(),
      status: z.enum(DEPLOYMENT_STATUSES).optional(),
      runtime: z.enum(['docker', 'k3s']).optional(),
      q: z.string().max(100).optional().describe('Free search: application, target, run number (#129).'),
      ...pageArguments,
    }),
    permission: 'deployment:read',
  }),
  rest({
    name: 'deploy',
    title: 'Deploy an application',
    description: [
      'Deploys an application to a target, in the background: answers 202 with the deployment id at once. Follow it with deployment_wait, then deployment_logs if it failed.',
      'The pipeline: preflight, port, render (Compose or Kubernetes), upload, build on the target, scans, deploy, healthcheck — and an automatic rollback to the previous version if the healthcheck fails (autoRollback, on by default).',
      '`images` replaces the image of services that deploy from one ({"web": "ghcr.io/acme/web:4f2c1e9"}) and saves it in the AppSpec — what a CI does after pushing a tag.',
    ].join(' '),
    method: 'POST',
    pattern: '/api/deployments',
    input: z.object({
      applicationId: uuid('The application id.'),
      targetId: uuid('The target id.'),
      runtime: z.enum(['docker', 'k3s']).describe('A runtime the target offers (target_get).'),
      autoRollback: z.boolean().optional().describe('Go back to the previous version if the healthcheck fails. Default true.'),
      images: z
        .record(z.string(), z.string())
        .optional()
        .describe('Image by service name, for services that deploy from an image.'),
      domains: z
        .array(routeInputSchema)
        .max(20)
        .optional()
        .describe("The application's domains on this target — the whole list. Absent: those set stay."),
    }),
    permission: 'deployment:create',
    applicationScoped: true,
  }),
  rest({
    name: 'deployment_get',
    title: 'Get a deployment',
    description: 'One deployment run: status, version, target, runtime, URL, and each pipeline step with its status.',
    method: 'GET',
    pattern: '/api/deployments/[id]',
    input: z.object({ id: uuid('The deployment id.') }),
    permission: 'deployment:read',
    applicationScoped: true,
  }),
  deploymentWait,
  deploymentLogs,
  rest({
    name: 'deployment_rollback',
    title: 'Roll a deployment back',
    description:
      'Puts the previous version back in service on the same target, from the release still present there — no rebuild. In the background: follow the returned deployment.',
    method: 'POST',
    pattern: '/api/deployments/[id]/rollback',
    input: z.object({ id: uuid('The deployment to roll back from.') }),
    permission: 'deployment:rollback',
    applicationScoped: true,
    annotations: { destructiveHint: true },
  }),
  rest({
    name: 'deployment_redeploy',
    title: 'Redeploy a known version',
    description:
      'Replays a version — the AppSpec frozen by an earlier deployment (application_versions) — as a new complete deployment, on any target. Unlike a rollback, it rebuilds and rescans.',
    method: 'POST',
    pattern: '/api/applications/[id]/redeploy',
    input: z.object({
      id: uuid('The application id.'),
      versionId: uuid('The deployment whose AppSpec is replayed.'),
      targetId: uuid('Where to deploy it.'),
      autoRollback: z.boolean().optional(),
    }),
    permission: 'deployment:create',
    applicationScoped: true,
  }),
  rest({
    name: 'deployment_destroy',
    title: 'Destroy a deployment',
    description:
      'Removes the application from the target: containers or namespace, volumes, release files, reserved port, proxy route. The run stays in the history. Irreversible for the data in its volumes.',
    method: 'DELETE',
    pattern: '/api/deployments/[id]',
    input: z.object({ id: uuid('The deployment id.') }),
    permission: 'deployment:destroy',
    annotations: { destructiveHint: true },
  }),
  rest({
    name: 'deployment_scans',
    title: "Read a deployment's scans",
    description: 'The vulnerability and SBOM scans of a deployment: scanner, image, verdict, counts by severity.',
    method: 'GET',
    pattern: '/api/deployments/[id]/scans',
    input: z.object({ id: uuid('The deployment id.') }),
    permission: 'scan:read',
  }),

  // ── What runs ──────────────────────────────────────────────────────────────
  rest({
    name: 'running_apps',
    title: 'List running applications',
    description:
      'The applications in service, machine by machine — each one a deployment, whose id the running_app_* tools take.',
    method: 'GET',
    pattern: '/api/apps',
    permission: 'deployment:read',
  }),
  rest({
    name: 'running_app_state',
    title: 'Read a running application state',
    description: 'The state of a running application: its services, their health, restarts, last check.',
    method: 'GET',
    pattern: '/api/apps/[id]/state',
    input: z.object({ id: uuid('The deployment id (running_apps).') }),
    permission: 'deployment:read',
  }),
  ...(['restart', 'stop', 'start'] as const).map((action) =>
    rest({
      name: `running_app_${action}`,
      title: `${action[0]!.toUpperCase()}${action.slice(1)} a running application`,
      description:
        action === 'stop'
          ? 'Stops a running application. Volumes, port and domain stay: running_app_start brings it back, no redeployment.'
          : action === 'start'
            ? 'Starts an application that was stopped, as it was.'
            : "Restarts a running application's services, without redeploying.",
      method: 'POST',
      pattern: `/api/apps/[id]/${action}`,
      input: z.object({ id: uuid('The deployment id (running_apps).') }),
      permission: 'deployment:restart',
      annotations: { destructiveHint: action === 'stop' },
    }),
  ),

  // ── Watching ───────────────────────────────────────────────────────────────
  rest({
    name: 'domains_list',
    title: 'List domains',
    description:
      'Every domain of the instance: the proxy serving it, whether it answers, its certificate and days left. `attention` flags those that need a look.',
    method: 'GET',
    pattern: '/api/domains',
    permission: 'application:read',
  }),
  rest({
    name: 'monitors_list',
    title: 'List monitors',
    description: 'The HTTP and TLS probes, with their state, last measurement and open incident.',
    method: 'GET',
    pattern: '/api/monitors',
    permission: 'monitor:read',
  }),
  rest({
    name: 'findings_list',
    title: 'Search vulnerabilities',
    description: 'Vulnerabilities found by the scans, across deployments, with filters.',
    method: 'GET',
    pattern: '/api/findings',
    input: z.object({
      cveId: z.string().max(200).optional(),
      severity: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'UNKNOWN']).optional(),
      applicationId: uuid('Only this application.').optional(),
      deploymentId: uuid('Only this deployment.').optional(),
      ...pageArguments,
    }),
    permission: 'scan:read',
  }),
  rest({
    name: 'audit_search',
    title: 'Search the audit log',
    description:
      'Who did what, when, from where — every action and every refusal, including those made through this token. Newest first.',
    method: 'GET',
    pattern: '/api/audit-logs',
    input: z.object({
      q: z.string().max(200).optional().describe('Free search: action, resource, actor, IP, payload.'),
      action: z.string().max(120).optional().describe('An exact action, e.g. deployment.created.'),
      resourceType: z.string().max(60).optional(),
      severity: z.string().max(60).optional().describe('One or several, comma-separated: low,medium,high,critical.'),
      from: z.string().max(40).optional().describe('ISO 8601 instant, or a day (2026-09-30).'),
      to: z.string().max(40).optional(),
      ...pageArguments,
    }),
    permission: 'audit:read',
  }),
];

/**
 * The tools a caller is offered: those it holds the permission for, and with a
 * token limited to some applications, only those whose route accepts it.
 * Listing is not allowing: a tool absent from the list is still refused by its
 * route if called.
 */
export function visibleTools(auth: ToolContext['auth']): Tool[] {
  const limited = auth.token?.applications != null;
  return TOOLS.filter((tool) => {
    if (tool.permission === null) return true;
    if (!auth.can(tool.permission)) return false;
    return !limited || tool.applicationScoped === true;
  });
}

export function findTool(name: string): Tool | undefined {
  return TOOLS.find((tool) => tool.name === name);
}
