import { z } from 'zod';

/**
 * The Model Context Protocol's envelope — JSON-RPC 2.0 over the "Streamable
 * HTTP" transport, in its stateless form: one POST carries one message (or a
 * batch), the answer comes back in the HTTP response, as JSON.
 *
 * ── Why not the official SDK ────────────────────────────────────────────────
 * `@modelcontextprotocol/sdk` brings Express, Hono, CORS, a rate limiter and an
 * OAuth client along with it (1.32.1, read on 2026-10-07): a second HTTP server
 * inside the Next one. What Pupitre needs from the protocol fits in this file —
 * `initialize`, `ping`, the tools and the resources —, and the rest is already
 * the panel's: authentication by API token, permissions, audit log, Zod.
 *
 * ── Stateless, on purpose ───────────────────────────────────────────────────
 * No `Mcp-Session-Id`, no server-initiated stream (`GET` answers 405, which the
 * transport allows). Each call is authenticated by its token and stands on its
 * own: the panel can restart between two calls without the agent noticing it.
 *
 * A pure module, without `server-only`: it is tested without a server.
 */

/** The protocol revisions understood, newest first. */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'] as const;
export const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

export type ProtocolVersion = (typeof SUPPORTED_PROTOCOL_VERSIONS)[number];

/**
 * The revision answered to `initialize`: the client's when it is known, ours
 * otherwise — the client then decides whether it can follow, as the
 * specification says.
 */
export function negotiateProtocolVersion(requested: unknown): ProtocolVersion {
  return isSupportedProtocolVersion(requested) ? requested : LATEST_PROTOCOL_VERSION;
}

export function isSupportedProtocolVersion(value: unknown): value is ProtocolVersion {
  return (SUPPORTED_PROTOCOL_VERSIONS as readonly unknown[]).includes(value);
}

/* ─── JSON-RPC ─────────────────────────────────────────────────────────────── */

export const JSON_RPC_ERRORS = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  /** MCP: an unknown resource. */
  resourceNotFound: -32002,
} as const;

const idSchema = z.union([z.string(), z.number()]);

const messageSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: idSchema.optional(),
  method: z.string().min(1),
  params: z.record(z.string(), z.unknown()).optional(),
});

/** A client's response to a request of ours: there are none, it is ignored. */
const responseSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: idSchema.nullable(),
  result: z.unknown().optional(),
  error: z.unknown().optional(),
});

export type JsonRpcId = z.infer<typeof idSchema>;

export type IncomingMessage =
  | { kind: 'request'; id: JsonRpcId; method: string; params: Record<string, unknown> }
  | { kind: 'notification'; method: string; params: Record<string, unknown> }
  | { kind: 'response' }
  | { kind: 'invalid'; id: JsonRpcId | null };

/** Sorts one JSON-RPC message: a request expects an answer, the rest does not. */
export function readMessage(raw: unknown): IncomingMessage {
  const message = messageSchema.safeParse(raw);
  if (message.success) {
    const { id, method, params = {} } = message.data;
    return id === undefined
      ? { kind: 'notification', method, params }
      : { kind: 'request', id, method, params };
  }
  if (responseSchema.safeParse(raw).success) return { kind: 'response' };
  const id =
    typeof raw === 'object' && raw !== null && 'id' in raw ? idSchema.safeParse(raw.id) : null;
  return { kind: 'invalid', id: id?.success ? id.data : null };
}

export type JsonRpcResponse =
  | { jsonrpc: '2.0'; id: JsonRpcId; result: unknown }
  | {
      jsonrpc: '2.0';
      id: JsonRpcId | null;
      error: { code: number; message: string; data?: unknown };
    };

export function rpcResult(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

export function rpcError(
  id: JsonRpcId | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return {
    jsonrpc: '2.0',
    id,
    error: data === undefined ? { code, message } : { code, message, data },
  };
}

/* ─── What a tool returns ──────────────────────────────────────────────────── */

export type ToolContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

/**
 * A tool's outcome. `isError`: the tool ran and failed — a refusal, a 409, an
 * invalid argument. The agent reads it and can correct itself; a protocol error
 * would only tell it that the call did not go through.
 */
export type ToolResult = { content: ToolContent[]; isError?: boolean };

/** Beyond this, a text is cut: an agent's context is not a log archive. */
export const MAX_TOOL_TEXT = 60_000;

export function textResult(text: string, isError = false): ToolResult {
  const cut =
    text.length > MAX_TOOL_TEXT
      ? `${text.slice(0, MAX_TOOL_TEXT)}\n\n[… truncated: ${text.length - MAX_TOOL_TEXT} more characters. Narrow the request — filters, pagination, a tail.]`
      : text;
  return isError ? { content: [{ type: 'text', text: cut }], isError: true } : { content: [{ type: 'text', text: cut }] };
}

/** A tool's annotations — hints for the client, never a guarantee. */
export type ToolAnnotations = {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
};
