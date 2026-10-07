import { z } from 'zod';
import { DOC_CHAPTERS, isDocSlug } from '@/lib/docs/chapters';
import { listChapters, readChapter } from '@/lib/docs/content';
import {
  JSON_RPC_ERRORS,
  negotiateProtocolVersion,
  readMessage,
  rpcError,
  rpcResult,
  textResult,
  type JsonRpcResponse,
} from './protocol';
import { findTool, visibleTools, type ToolContext } from './tools';

/**
 * What the MCP endpoint answers, message by message.
 *
 * The capabilities are the tools and the resources — the documentation's
 * chapters, `pupitre://docs/<language>/<slug>`, which a client can attach to a
 * conversation as they are. No prompts, no sampling, no notifications from the
 * server: the endpoint is stateless (`protocol.ts`).
 *
 * Not `server-only`: the route gives it the means to call the API and to log
 * (`ServerContext`), and the tests give it fakes.
 */

export type ToolCallEvent = {
  tool: string;
  userId: string;
  tokenId: string | null;
  isError: boolean;
  durationMs: number;
  error?: unknown;
};

export type ServerContext = ToolContext & {
  /** Each tool call, once it is over — for the panel's logs. */
  onToolCall?: (event: ToolCallEvent) => void;
};

const SERVER_INFO = { name: 'pupitre', title: 'Pupitre', version: '0.1.0' };

const INSTRUCTIONS = [
  'Pupitre is a self-hosted control plane that deploys web applications to remote machines (targets), with Docker Compose or K3s.',
  'An application is described by an AppSpec, neutral JSON that knows neither Docker nor Kubernetes; a deployment renders it on one target, in the background.',
  'Typical flow: whoami → targets_list → applications_list or application_create (validate with appspec_validate) → deploy → deployment_wait → deployment_logs if it failed → deployment_rollback if needed.',
  'Every call acts with the permissions of the API token, and every action is recorded in the audit log under its account.',
  'Anything without a dedicated tool is reachable with api_request; the docs tool holds the full documentation, the API reference included.',
].join(' ');

const toolCallSchema = z.object({
  name: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()).optional(),
});

const resourceReadSchema = z.object({ uri: z.string().min(1) });

function resourceUri(language: string, slug: string): string {
  return `pupitre://docs/${language}/${slug}`;
}

function parseResourceUri(uri: string): { language: 'fr' | 'en'; slug: string } | null {
  const match = /^pupitre:\/\/docs\/(fr|en)\/([a-z0-9-]+)$/.exec(uri);
  if (!match || !isDocSlug(match[2]!)) return null;
  return { language: match[1] as 'fr' | 'en', slug: match[2]! };
}

async function callTool(params: Record<string, unknown>, context: ServerContext) {
  const parsed = toolCallSchema.safeParse(params);
  if (!parsed.success) return null;
  const tool = findTool(parsed.data.name);
  if (!tool) return undefined;

  const input = tool.input.safeParse(parsed.data.arguments ?? {});
  if (!input.success) {
    // An invalid argument is the tool's failure, not the protocol's: the agent
    // reads why and corrects its call.
    return textResult(
      `Invalid arguments for ${tool.name}:\n${input.error.issues
        .map((issue) => `• ${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('\n')}`,
      true,
    );
  }

  const startedAt = Date.now();
  const report = (isError: boolean, error?: unknown) =>
    context.onToolCall?.({
      tool: tool.name,
      userId: context.auth.userId,
      tokenId: context.auth.token?.id ?? null,
      isError,
      durationMs: Date.now() - startedAt,
      ...(error === undefined ? {} : { error }),
    });
  try {
    const result = await tool.run(input.data, context);
    report(result.isError === true);
    return result;
  } catch (error) {
    report(true, error);
    return textResult(`${tool.name} failed inside Pupitre — see the panel's logs.`, true);
  }
}

/** One message in, at most one answer out — `null` for a notification. */
export async function handleMessage(
  raw: unknown,
  context: ServerContext,
): Promise<JsonRpcResponse | null> {
  const message = readMessage(raw);
  if (message.kind === 'response' || message.kind === 'notification') return null;
  if (message.kind === 'invalid') {
    return rpcError(message.id, JSON_RPC_ERRORS.invalidRequest, 'Invalid JSON-RPC message');
  }

  const { id, method, params } = message;
  switch (method) {
    case 'initialize':
      return rpcResult(id, {
        protocolVersion: negotiateProtocolVersion(params.protocolVersion),
        capabilities: {
          tools: { listChanged: false },
          resources: { listChanged: false, subscribe: false },
        },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });

    case 'ping':
      return rpcResult(id, {});

    case 'tools/list':
      return rpcResult(id, {
        tools: visibleTools(context.auth).map((tool) => ({
          name: tool.name,
          title: tool.title,
          description: tool.description,
          inputSchema: z.toJSONSchema(tool.input, { io: 'input', unrepresentable: 'any' }),
          annotations: tool.annotations,
        })),
      });

    case 'tools/call': {
      const result = await callTool(params, context);
      if (result === null) return rpcError(id, JSON_RPC_ERRORS.invalidParams, 'Expected { name, arguments }');
      if (result === undefined) {
        return rpcError(id, JSON_RPC_ERRORS.invalidParams, `Unknown tool: ${String(params.name)}`);
      }
      return rpcResult(id, result);
    }

    case 'resources/list':
      return rpcResult(id, {
        resources: listChapters(context.language, context.origin).map((chapter) => ({
          uri: resourceUri(context.language, chapter.slug),
          name: chapter.slug,
          title: chapter.title,
          description: chapter.summary,
          mimeType: 'text/markdown',
        })),
      });

    case 'resources/templates/list':
      return rpcResult(id, {
        resourceTemplates: [
          {
            uriTemplate: 'pupitre://docs/{language}/{slug}',
            name: 'documentation',
            title: 'Pupitre documentation chapter',
            description: `A chapter, in fr or en. Slugs: ${DOC_CHAPTERS.map((chapter) => chapter.slug).join(', ')}.`,
            mimeType: 'text/markdown',
          },
        ],
      });

    case 'resources/read': {
      const parsed = resourceReadSchema.safeParse(params);
      const target = parsed.success ? parseResourceUri(parsed.data.uri) : null;
      if (!parsed.success || !target) {
        return rpcError(id, JSON_RPC_ERRORS.resourceNotFound, 'Resource not found', {
          uri: parsed.success ? parsed.data.uri : null,
        });
      }
      return rpcResult(id, {
        contents: [
          {
            uri: parsed.data.uri,
            mimeType: 'text/markdown',
            text: readChapter(target.language, target.slug, context.origin).markdown,
          },
        ],
      });
    }

    default:
      return rpcError(id, JSON_RPC_ERRORS.methodNotFound, `Method not found: ${method}`);
  }
}
