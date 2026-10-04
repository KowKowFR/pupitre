import { deployLogLineSchema, type DeployLogLine } from '@pupitre/core';
import {
  asc,
  deploymentSteps,
  eq,
  getDb,
  getDeploymentSummary,
  logAudit,
  sql,
  type DeploymentSummary,
} from '@pupitre/db';
import { z } from 'zod';
import { deployments as messages } from '@/i18n/messages/deployments';
import { NotFoundError, msg } from '@/lib/errors';
import { exportResponse } from '@/lib/export';
import { apiRoute, readSearchParams } from '@/lib/http';
import { requirePermission } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid() });
const querySchema = z.object({
  /** `text`: readable by a human. `jsonl`: one line = one JSON object. */
  format: z.enum(['text', 'jsonl']).default('text'),
});

type Context = { params: Promise<{ id: string }> };

/**
 * The size of a slice of `deployment_steps.log` read back from the database.
 *
 * A step's log is a single `text` column that can weigh several megabytes.
 * Reading it in one go — what `readDeploymentLog()` does for the SSE replay —
 * would load everything into memory before writing the first byte. So we cut it
 * into slices of characters, and the response goes out from the first one.
 */
const CHUNK_CHARS = 64 * 1024;

/** Beyond this, the current slice is pushed into the stream rather than stacked. */
const FLUSH_CHARS = 16 * 1024;

/**
 * Exporting a deployment's **persisted** log.
 *
 * Unlike the application logs, this log is finite: it has a start, an end, and
 * it is entirely in the database. The export is therefore an exact read, not a
 * snapshot — the file contains everything `deployment_steps.log` contains, in
 * the order of the steps then of the lines.
 */
export const GET = apiRoute<Context>(async (request, context) => {
  const auth = await requirePermission(request, 'deployment:read');
  const { id } = paramsSchema.parse(await context.params);
  const { format } = readSearchParams(request, querySchema);

  const deployment = await getDeploymentSummary(id);
  if (!deployment) throw new NotFoundError(msg(messages, 'error.notFound', { id }));

  const exportedAt = new Date();
  const render = format === 'jsonl' ? renderJsonl : renderText;

  // The JSONL carries no header: a line of the file must stay a log line,
  // otherwise a `wc -l` would lie and `jq` would stumble.
  const header = format === 'text' ? textHeader(deployment, exportedAt, auth.email) : null;

  let lines = 0;
  async function* chunks(): AsyncGenerator<string, void, undefined> {
    if (header) yield header;
    yield* streamLogChunks(id, render, () => {
      lines += 1;
    });
  }

  const extension = format === 'jsonl' ? 'jsonl' : 'log';
  const stamp = (deployment.finishedAt ?? deployment.createdAt).toISOString().slice(0, 10);

  return exportResponse({
    chunks: chunks(),
    contentType:
      format === 'jsonl' ? 'application/x-ndjson; charset=utf-8' : 'text/plain; charset=utf-8',
    filename: `${deployment.applicationSlug}-v${deployment.version}-${stamp}.${extension}`,
    fallbackName: 'deployment-log.log',
    context: { deploymentId: id },
    onSettled: async (complete) => {
      await logAudit({
        actorId: auth.userId,
        action: 'deployment.logs.exported',
        resourceType: 'deployment',
        resourceId: id,
        after: {
          format,
          lines,
          complete,
          applicationSlug: deployment.applicationSlug,
          number: deployment.number,
          version: deployment.version,
        },
        ip: auth.ip,
      });
    },
  });
});

// ─── lecture en base, par tranches ────────────────────────────────────────────

/**
 * Produces the file piece by piece, without ever holding more than one slice of
 * log in memory.
 *
 * A slice necessarily cuts a line in two: the rest is carried over to the next
 * slice (`remainder`). It is the only state to carry from one round to the next,
 * and it is what makes the cutting invisible in the produced file.
 */
async function* streamLogChunks(
  deploymentId: string,
  render: (line: DeployLogLine) => string,
  countLine: () => void,
): AsyncGenerator<string, void, undefined> {
  const db = getDb();

  // We only read the logs' size here, not their content: the list of steps must
  // fit in memory, their logs need not.
  const steps = await db
    .select({
      id: deploymentSteps.id,
      size: sql<number>`length(${deploymentSteps.log})`.mapWith(Number),
    })
    .from(deploymentSteps)
    .where(eq(deploymentSteps.deploymentId, deploymentId))
    .orderBy(asc(deploymentSteps.order));

  let pending = '';

  for (const step of steps) {
    if (step.size === 0) continue;

    let offset = 1; // PostgreSQL's `substr()` is 1-indexed.
    let remainder = '';

    while (offset <= step.size) {
      const [row] = await db
        .select({
          chunk: sql<string>`substr(${deploymentSteps.log}, ${offset}, ${CHUNK_CHARS})`,
        })
        .from(deploymentSteps)
        .where(eq(deploymentSteps.id, step.id));
      offset += CHUNK_CHARS;
      if (!row) break;

      const parts = (remainder + row.chunk).split('\n');
      remainder = parts.pop() ?? '';

      for (const raw of parts) {
        const rendered = renderRaw(raw, render);
        if (rendered === null) continue;
        countLine();
        pending += rendered;
        if (pending.length >= FLUSH_CHARS) {
          yield pending;
          pending = '';
        }
      }
    }

    // The last line of a step the worker did not end with a newline: it is complete,
    // it must come out.
    const rendered = renderRaw(remainder, render);
    if (rendered !== null) {
      countLine();
      pending += rendered;
    }
  }

  if (pending.length > 0) yield pending;
}

/** `null` for an empty line or one truncated by an abrupt worker stop. */
function renderRaw(raw: string, render: (line: DeployLogLine) => string): string | null {
  if (raw.trim().length === 0) return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = deployLogLineSchema.safeParse(json);
  return parsed.success ? render(parsed.data) : null;
}

// ─── rendus ───────────────────────────────────────────────────────────────────

/** Fixed columns: timestamp, step, channel, message. Nothing is lost. */
function renderText(line: DeployLogLine): string {
  const stream = line.stream === 'stderr' ? 'err' : 'out';
  return `${line.ts}  ${line.step.padEnd(14)}  ${stream}  ${line.line}\n`;
}

function renderJsonl(line: DeployLogLine): string {
  return `${JSON.stringify(line)}\n`;
}

/**
 * The text file's header, as `#` comment lines.
 *
 * It says where the file comes from — without it, an exported log is only a wall
 * of lines without an owner. The `#` prefix makes it filterable
 * (`grep -v '^#'`) and sets it apart from the log lines, which all start with a
 * timestamp.
 */
function textHeader(
  deployment: DeploymentSummary,
  exportedAt: Date,
  actorEmail: string,
): string {
  const started = deployment.startedAt?.toISOString() ?? '—';

  // An exported file is not interface: it is a dated artifact, downloaded,
  // archived, read again months later. Its header is in the project's
  // language, English, whatever the instance's language: two exports of the
  // same deployment must read side by side even if the language changed in
  // between. The log lines below it stay in the language they were written in.
  const finished = deployment.finishedAt?.toISOString() ?? 'not finished';
  const failure = deployment.failedStep ? ` (failed at "${deployment.failedStep}")` : '';

  return `# Deployment log — ${deployment.applicationSlug} v${deployment.version}
# Deployment: #${deployment.number} · ${deployment.id}
# Target: ${deployment.targetName} (${deployment.targetHost}) · ${deployment.runtime}
# Status: ${deployment.status}${failure}
# Started: ${started} · finished: ${finished}
# Full log as kept in the database, in step order.
# Exported on ${exportedAt.toISOString()} by ${actorEmail}
#
`;
}
