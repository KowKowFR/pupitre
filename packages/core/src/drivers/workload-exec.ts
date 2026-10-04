import { execStream } from '../ssh/client.js';
import type { SshSession } from '../ssh/client.js';
import type { LogSink } from './types.js';

/**
 * A command in a workload, shared by both drivers: only the command line changes
 * (`docker exec` on one side, `kubectl exec` on the other). The rest — the
 * output cap, the timeout, the exit code — must behave the same, otherwise the
 * same console would say two things.
 */

export type WorkloadExecOptions = {
  timeoutMs: number;
  /** Beyond this, lines are no longer sent: a chatty command does not flood the screen. */
  maxLines: number;
};

export type WorkloadExecResult = {
  exitCode: number;
  truncated: boolean;
  timedOut: boolean;
};

/**
 * POSIX escaping in single quotes. The operator's command goes through **two**
 * shells: the machine's (SSH), then `sh -c` in the workload. Quoted here, it
 * stays a single string for the first, and therefore only runs in the second —
 * never on the host.
 */
export function quoteForShell(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export async function runBoundedExec(
  session: SshSession,
  command: string,
  onLine: LogSink,
  options: WorkloadExecOptions,
): Promise<WorkloadExecResult> {
  let lines = 0;
  let truncated = false;
  const result = await execStream(
    session,
    command,
    (line) => {
      lines += 1;
      if (lines <= options.maxLines) onLine(line);
      else truncated = true;
    },
    // A command's output can carry anything, secrets included: it only goes to the
    // screen that asked for it, never into a log.
    { timeout: options.timeoutMs, logOutput: false },
  );
  return { exitCode: result.code, truncated, timedOut: result.timedOut };
}
