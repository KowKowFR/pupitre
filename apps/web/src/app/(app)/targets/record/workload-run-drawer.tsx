'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { CornerDownLeft, RotateCw, ScrollText, SquareTerminal } from 'lucide-react';
import {
  WORKLOAD_EXEC_MAX_COMMAND,
  WORKLOAD_EXEC_MAX_LINES,
  WORKLOAD_EXEC_TIMEOUT_SEC,
  type Workload,
} from '@pupitre/core';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Drawer, DrawerBody, DrawerHeader } from '@/components/ui/drawer';
import { Input } from '@/components/ui/input';
import { SegmentedControl } from '@/components/ui/segmented';
import { useT } from '@/i18n/client';
import { common } from '@/i18n/messages/common';
import { targets as messages } from '@/i18n/messages/targets';
import { randomUuid } from '@/lib/secure-origin';

/**
 * A workload's log, or a console in it.
 *
 * Each read, each command is a **run**: an identifier drawn here, a stream opened
 * on `?run=` *before* starting the job (otherwise the first lines would be lost),
 * then the job itself. The server reserves the identifier for this session: a
 * command's output only shows for whoever started it.
 *
 * The console is not a terminal: no TTY, no waiting prompt. A command, its
 * output, its exit code — and a line in the audit log.
 */

export type RunMode = 'logs' | 'exec';

type Entry = {
  run: string;
  command: string | null;
  lines: string[];
  status: 'running' | 'succeeded' | 'failed';
  exitCode: number | null;
  detail: string | null;
  timedOut: boolean;
  truncated: boolean;
};

type ApiError = { error?: { message?: string } };

const MAX_LINES = 2000;
const KEEP_COMMANDS = 20;
const TAILS = ['100', '300', '1000'] as const;

/**
 * `docker logs --timestamps`: "2026-10-01T09:12:33.123456789Z text".
 * `kubectl logs --prefix --timestamps`: the same, preceded by "[pod/x/c]".
 */
const STAMPED =
  /^(\[[^\]]*\] )?(\d{4}-\d{2}-\d{2}T(\d{2}:\d{2}:\d{2})[.\d]*(?:Z|[+-]\d{2}:\d{2})) ?(.*)$/s;

function blankEntry(run: string, command: string | null): Entry {
  return {
    run,
    command,
    lines: [],
    status: 'running',
    exitCode: null,
    detail: null,
    timedOut: false,
    truncated: false,
  };
}

function LogLine({ line }: { line: string }) {
  const match = STAMPED.exec(line);
  if (!match) return <div className="ln">{line}</div>;
  const [, prefix, iso, time, text] = match;
  return (
    <div className="ln">
      <span className="ts" title={iso}>
        {time}
      </span>
      {prefix ? <span className="sv">{prefix.trim()}</span> : null}
      <span>{text}</span>
    </div>
  );
}

export function WorkloadRunDrawer({
  targetId,
  workload,
  mode,
  onClose,
}: {
  targetId: string;
  workload: Workload & { ref: string };
  mode: RunMode;
  onClose: () => void;
}) {
  const t = useT(messages);
  const tc = useT(common);
  const [tail, setTail] = useState<(typeof TAILS)[number]>('300');
  const [command, setCommand] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const streams = useRef(new Map<string, EventSource>());
  const scroller = useRef<HTMLDivElement>(null);

  // The log is read as soon as it opens: its first run exists before the first
  // render, the effect only plugs the stream into it.
  const [initialRun] = useState(() => (mode === 'logs' ? randomUuid() : null));
  const [entries, setEntries] = useState<Entry[]>(() =>
    initialRun ? [blankEntry(initialRun, null)] : [],
  );

  const patch = useCallback((run: string, change: (entry: Entry) => Entry) => {
    setEntries((list) => list.map((entry) => (entry.run === run ? change(entry) : entry)));
  }, []);

  /** Plugs the stream, then starts the job. Only writes state in callbacks. */
  const connect = useCallback(
    async (run: string, body: Record<string, unknown>) => {
      const stream = new EventSource(`/api/targets/${targetId}/workloads/events?run=${run}`);
      streams.current.set(run, stream);
      const finish = () => {
        stream.close();
        streams.current.delete(run);
      };

      stream.addEventListener('log', (event) => {
        const payload = JSON.parse((event as MessageEvent<string>).data) as {
          run?: string;
          line: string;
        };
        if (payload.run !== run) return;
        patch(run, (entry) => ({
          ...entry,
          lines: [...entry.lines, payload.line].slice(-MAX_LINES),
        }));
      });
      stream.addEventListener('lifecycle', (event) => {
        const payload = JSON.parse((event as MessageEvent<string>).data) as {
          run?: string;
          status: Entry['status'] | 'started';
          detail: string | null;
          exitCode?: number | null;
          timedOut?: boolean;
          truncated?: boolean;
        };
        if (payload.run !== run || payload.status === 'started') return;
        const status = payload.status;
        patch(run, (entry) => ({
          ...entry,
          status,
          exitCode: payload.exitCode ?? null,
          detail: payload.detail,
          timedOut: payload.timedOut === true,
          truncated: payload.truncated === true,
        }));
        finish();
      });

      const ready = await new Promise<boolean>((resolve) => {
        stream.addEventListener('ready', () => resolve(true), { once: true });
        stream.onerror = () => resolve(false);
      });
      if (!ready) {
        patch(run, (entry) => ({ ...entry, status: 'failed', detail: t('run.streamError') }));
        finish();
        return;
      }

      const response = await fetch(
        `/api/targets/${targetId}/workloads/${encodeURIComponent(workload.ref)}/${mode}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...body, run }),
        },
      ).catch(() => null);
      if (!response?.ok) {
        const error = response
          ? ((await response.json().catch(() => ({}))) as ApiError).error?.message
          : undefined;
        patch(run, (entry) => ({
          ...entry,
          status: 'failed',
          detail: error ?? tc('http.failure', { status: response?.status ?? 0 }),
        }));
        finish();
      }
    },
    [mode, patch, t, targetId, tc, workload.ref],
  );

  useEffect(() => {
    if (initialRun) void connect(initialRun, { tail: Number(tail) });
    // Only once, on opening: the re-reads go through `start`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialRun]);

  useEffect(() => {
    const open = streams.current;
    return () => {
      for (const stream of open.values()) stream.close();
      open.clear();
    };
  }, []);

  // The bottom of the terminal stays in view: that is where the output arrives.
  useEffect(() => {
    const element = scroller.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [entries]);

  function start(body: Record<string, unknown>, label: string | null) {
    const run = randomUuid();
    const entry = blankEntry(run, label);
    // The log only keeps its last read; the console, its last commands.
    setEntries((list) =>
      mode === 'logs' ? [entry] : [...list.slice(-(KEEP_COMMANDS - 1)), entry],
    );
    void connect(run, body);
  }

  const running = entries.some((entry) => entry.status === 'running');

  function submit() {
    const value = command.trim();
    if (!value || running) return;
    setHistory((list) => [...list.filter((item) => item !== value), value].slice(-50));
    setCursor(null);
    setCommand('');
    start({ command: value }, value);
  }

  function recall(direction: -1 | 1) {
    if (history.length === 0) return;
    const next =
      cursor === null
        ? direction === -1
          ? history.length - 1
          : null
        : cursor + direction >= history.length
          ? null
          : Math.max(0, cursor + direction);
    setCursor(next);
    setCommand(next === null ? '' : (history[next] ?? ''));
  }

  const latest = entries.at(-1);
  const isLogs = mode === 'logs';

  return (
    <Drawer open onOpenChange={(open) => (open ? undefined : onClose())} wide>
      <DrawerHeader
        icon={isLogs ? <ScrollText /> : <SquareTerminal />}
        kind={isLogs ? t('run.logs.kind') : t('run.exec.kind')}
        route={workload.image ?? undefined}
        title={workload.name}
        state={
          <>
            {workload.scope ? <span className="mono text-text-3">{workload.scope}</span> : null}
            {latest ? (
              <Badge
                variant={
                  latest.status === 'running'
                    ? 'accent'
                    : latest.status === 'failed' || (latest.exitCode ?? 0) !== 0
                      ? 'danger'
                      : 'ok'
                }
                dot
              >
                {latest.status === 'running'
                  ? t('progress.running')
                  : latest.status === 'failed'
                    ? t('progress.failed')
                    : latest.exitCode !== null
                      ? t('run.exec.exit', { code: latest.exitCode })
                      : t('progress.done')}
              </Badge>
            ) : null}
          </>
        }
        extra={
          <p className="t-sm text-text-2">{isLogs ? t('run.logs.note') : t('run.exec.note')}</p>
        }
      />
      <DrawerBody className="gap-3">
        {!isLogs && !workload.exec ? (
          <Alert variant="warn">{t('run.exec.notRunning', { name: workload.name })}</Alert>
        ) : null}

        <section
          className="term min-h-[24rem] flex-1"
          aria-label={isLogs ? t('run.logs.kind') : t('run.exec.kind')}
        >
          <div className="term-h">
            <span className="font-semibold text-term-fg">
              {isLogs ? t('run.logs.kind') : t('run.exec.kind')}
            </span>
            {isLogs ? (
              <span className="ml-auto flex items-center gap-2">
                <SegmentedControl
                  label={t('run.logs.tail')}
                  value={tail}
                  options={TAILS.map((value) => ({ value, label: value }))}
                  onChange={(value) => setTail(value)}
                />
                <Button
                  size="sm"
                  variant="ghost"
                  className="btn-term"
                  loading={running}
                  onClick={() => start({ tail: Number(tail) }, null)}
                >
                  {running ? null : <RotateCw aria-hidden />}
                  {t('run.logs.refresh')}
                </Button>
              </span>
            ) : entries.length > 0 ? (
              <Button
                size="sm"
                variant="ghost"
                className="btn-term ml-auto"
                disabled={running}
                onClick={() => setEntries([])}
              >
                {t('run.exec.clear')}
              </Button>
            ) : null}
          </div>

          <div ref={scroller} className="term-b" aria-live="polite">
            {entries.length === 0 ? (
              <div className="ln d">{isLogs ? t('progress.waiting') : t('run.exec.empty')}</div>
            ) : null}
            {entries.map((entry) => (
              <div key={entry.run} className={isLogs ? undefined : 'pb-2'}>
                {entry.command !== null ? (
                  <div className="ln o">
                    <span className="d">$</span>
                    <span>{entry.command}</span>
                  </div>
                ) : null}
                {entry.lines.map((line, index) => (
                  <LogLine key={index} line={line} />
                ))}
                {entry.status === 'running' && entry.lines.length === 0 ? (
                  <div className="ln d">{t('progress.waiting')}</div>
                ) : null}
                {entry.status === 'succeeded' && isLogs && entry.lines.length === 0 ? (
                  <div className="ln d">{t('run.logs.empty')}</div>
                ) : null}
                {entry.truncated ? (
                  <div className="ln is-warn">
                    <span className="w">
                      {t('run.truncated', { max: WORKLOAD_EXEC_MAX_LINES })}
                    </span>
                  </div>
                ) : null}
                {entry.status === 'failed' ? (
                  <div className="ln is-err">
                    <span className="e">{entry.detail ?? t('progress.failed')}</span>
                  </div>
                ) : entry.status === 'succeeded' && !isLogs ? (
                  <div className="ln">
                    <span className={entry.exitCode === 0 ? 'd' : 'e'}>
                      {entry.timedOut || entry.exitCode === null
                        ? t('run.exec.timeout', { seconds: WORKLOAD_EXEC_TIMEOUT_SEC })
                        : t('run.exec.exit', { code: entry.exitCode })}
                    </span>
                  </div>
                ) : null}
              </div>
            ))}
          </div>

          {!isLogs ? (
            <form
              className="flex items-center gap-2 border-t border-term-line px-3.5 py-2.5 font-sans"
              onSubmit={(event) => {
                event.preventDefault();
                submit();
              }}
            >
              <span className="mono text-term-dim" aria-hidden>
                $
              </span>
              <Input
                className="input-sm mono flex-1"
                value={command}
                maxLength={WORKLOAD_EXEC_MAX_COMMAND}
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                disabled={!workload.exec}
                aria-label={t('run.exec.label')}
                placeholder={t('run.exec.placeholder')}
                onChange={(event) => {
                  setCommand(event.target.value);
                  setCursor(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowUp') {
                    event.preventDefault();
                    recall(-1);
                  } else if (event.key === 'ArrowDown') {
                    event.preventDefault();
                    recall(1);
                  }
                }}
              />
              <Button
                type="submit"
                size="sm"
                variant="ghost"
                className="btn-term"
                loading={running}
                disabled={!workload.exec || command.trim().length === 0}
              >
                {running ? null : <CornerDownLeft aria-hidden />}
                {t('run.exec.submit')}
              </Button>
            </form>
          ) : null}
        </section>
      </DrawerBody>
    </Drawer>
  );
}
