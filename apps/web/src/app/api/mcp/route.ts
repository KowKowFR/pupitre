import { NextResponse } from 'next/server';
import { currentLanguage } from '@/i18n/server';
import { apiRoute } from '@/lib/http';
import {
  JSON_RPC_ERRORS,
  SUPPORTED_PROTOCOL_VERSIONS,
  isSupportedProtocolVersion,
  rpcError,
} from '@/lib/mcp/protocol';
import { callApi } from '@/lib/mcp/dispatch';
import { handleMessage, type ServerContext } from '@/lib/mcp/server';
import { logger } from '@/lib/logger';
import { requireCaller } from '@/lib/rbac';
import { panelOrigin } from '@/lib/sources';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** `deployment_wait` waits up to two minutes; the route gives itself a little more. */
export const maxDuration = 150;

/**
 * The MCP endpoint — Model Context Protocol, "Streamable HTTP" transport,
 * stateless (`src/lib/mcp/protocol.ts`).
 *
 * An agent connects with an API token (`Authorization: Bearer pup_…`), and only
 * with one: a browser session is not enough. Each tool goes through the REST
 * route that does the same thing, with the same token — the permissions, the
 * per-application scope, the audit log are those of the API.
 *
 * `apiRoute()` refuses a write sent by a browser from another origin: that is
 * the Origin check the specification requires against DNS rebinding.
 */
const handle = apiRoute(async (request) => {
  const auth = await requireCaller(request, { apiTokenOnly: true });

  const version = request.headers.get('mcp-protocol-version');
  if (version !== null && !isSupportedProtocolVersion(version)) {
    return NextResponse.json(
      rpcError(null, JSON_RPC_ERRORS.invalidRequest, 'Unsupported MCP-Protocol-Version', {
        supported: SUPPORTED_PROTOCOL_VERSIONS,
      }),
      { status: 400 },
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(await request.text());
  } catch {
    return NextResponse.json(rpcError(null, JSON_RPC_ERRORS.parseError, 'Parse error'), {
      status: 400,
    });
  }

  const context: ServerContext = {
    auth,
    language: await currentLanguage(),
    origin: panelOrigin(),
    call: (call) => callApi(request, call),
    onToolCall: ({ error, ...event }) => {
      if (error === undefined) logger.info(event, 'mcp tool called');
      else logger.error({ ...event, err: error }, 'mcp tool failed');
    },
  };
  const batch = Array.isArray(payload);
  const messages: unknown[] = Array.isArray(payload) ? payload : [payload];
  if (messages.length === 0) {
    return NextResponse.json(rpcError(null, JSON_RPC_ERRORS.invalidRequest, 'Empty batch'), {
      status: 400,
    });
  }
  const answers = [];
  for (const message of messages) {
    const answer = await handleMessage(message, context);
    if (answer !== null) answers.push(answer);
  }

  // Only notifications or responses: nothing to say, as the transport wants.
  if (answers.length === 0) return new Response(null, { status: 202 });
  return NextResponse.json(batch ? answers : answers[0]);
});

/**
 * A 401 says where to authenticate (RFC 6750): an MCP client that sees it
 * without a `WWW-Authenticate` header would not know a Bearer token is expected.
 */
export async function POST(request: Request, context: unknown): Promise<Response> {
  const response = await handle(request, context);
  if (response.status === 401) {
    response.headers.set('WWW-Authenticate', 'Bearer realm="pupitre"');
  }
  return response;
}

/** No server-initiated stream: the transport allows a 405 here. */
function notAllowed(): Response {
  return new Response(null, { status: 405, headers: { Allow: 'POST' } });
}

export const GET = notAllowed;
export const DELETE = notAllowed;
