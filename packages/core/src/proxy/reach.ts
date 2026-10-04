import { randomBytes } from 'node:crypto';
import { listeningPorts } from '../drivers/listening.js';
import type { LogSink, TargetContext } from '../drivers/types.js';
import { ufwState, UFW_MARKER } from '../drivers/ufw.js';
import type { PortRange } from '../ports.js';
import { exec } from '../ssh/client.js';
import type { ReachAttempt } from './types.js';
import { firstLine, shellQuote } from '../shell.js';
import type { UiLanguage } from '../i18n.js';
import { proxySay } from './messages.js';

/**
 * Does a proxy's machine really reach the one it must serve?
 *
 * A route that exists or a ping that answers do not prove it: a host's security
 * group, a firewall or an address that is not the right one let one through and
 * block the application. We therefore test the very path visitors will take:
 *
 *   1. from the proxy's machine, the route to the given address;
 *   2. on the served machine, an ephemeral listener on a free port **in the
 *      applications' range** — that is where the driver will publish;
 *   3. from the proxy's machine, a connection to `address:port`, which must
 *      bring back a token drawn for the occasion: it really is this machine that
 *      answered, not another one behind the same address;
 *   4. the listener notes the address the connection arrived from — the one to
 *      open the port to, NAT included.
 *
 * Nothing remains: the listener stops by itself, the firewall rule set for the
 * test is removed. No runtime is involved: it is the machine being tested, not
 * Docker or Kubernetes.
 */

/** How long the listener waits before stopping by itself. */
const LISTENER_LIFETIME_S = 30;
/** The time given to the connection from the proxy's machine. */
const CONNECT_TIMEOUT_S = 5;
const SHORT_MS = 30_000;
/** The comment of the test's ufw rule: recognizable, and removed right away. */
const REACH_UFW_COMMENT = `${UFW_MARKER}:reach`;

export type ReachFailure =
  /** The proxy's machine has no route to the address. */
  | 'no_route'
  /** No free port in the range, or no way to listen on the served machine. */
  | 'no_listener'
  /** Nothing came back: a firewall drops the packets, or the address leads nowhere. */
  | 'timeout'
  /** The address answers but refuses the port: a firewall in REJECT, or another machine. */
  | 'refused'
  /** Someone answered, but not the listener set up: it is not this machine. */
  | 'mismatch'
  | 'error';

export type ReachResult = {
  /** `null`: could not test — neither python3, nor perl, nor nc on the served machine. */
  ok: boolean | null;
  address: string;
  /** The port tested, taken from the applications' range. */
  port: number | null;
  /** The address from the proxy's machine to this one, according to its routing table. */
  routeSource: string | null;
  /** The address the connection arrived from, as seen from the served machine. */
  observedSource: string | null;
  /** The given address is one of the served machine's: we can publish on it. */
  bindable: boolean;
  failure: ReachFailure | null;
  /** The sentence to show: what was tested, or what blocks. */
  detail: string;
};

/**
 * Where the path is tested from: the proxy's machine, over SSH — or, for a
 * remote proxy Pupitre does not drive, the proxy itself, which relays the
 * request as it will relay visitors.
 */
export type ReachOrigin = {
  /** How to name it in messages: the machine, or the connection. */
  name: string;
  /**
   * The source address toward `address` according to the routing table. `null`:
   * no route; `undefined`: not applicable — a remote proxy does not tell it.
   */
  routeSource(address: string): Promise<string | null | undefined>;
  /** `GET /{token}` to `address:port`, rendered in curl's vocabulary. */
  connect(address: string, port: number, token: string): Promise<ReachAttempt>;
};

/** Test from the proxy's machine: `ip route get`, then `curl`. */
export function sshReachOrigin(proxyHost: TargetContext): ReachOrigin {
  return {
    name: proxyHost.target.name,
    async routeSource(address) {
      const quoted = shellQuote(address);
      const route = await exec(
        proxyHost.sshSession,
        `(ip route get ${quoted} || ip -6 route get ${quoted}) 2>/dev/null | head -1`,
        { timeout: SHORT_MS },
      );
      return /\bsrc\s+(\S+)/.exec(route.stdout)?.[1] ?? null;
    },
    async connect(address, port, token) {
      const host = address.includes(':') ? `[${address}]` : address;
      const connect = await exec(
        proxyHost.sshSession,
        // curl's code, taken right away: an `echo`'s would say nothing.
        `curl -s -m ${CONNECT_TIMEOUT_S} http://${host}:${port}/${token}; code=$?; echo; echo "curl=$code"`,
        { timeout: (CONNECT_TIMEOUT_S + 10) * 1000 },
      );
      return {
        curlCode: Number(/curl=(\d+)\s*$/.exec(connect.stdout)?.[1] ?? '1'),
        body: connect.stdout,
      };
    },
  };
}

/** The arrival address to keep for the firewall: the one observed, otherwise the route's. */
export function reachSource(result: ReachResult): string | null {
  return result.observedSource ?? result.routeSource;
}

// ─── the pieces that can be tested alone ─────────────────────────────────────

/**
 * Candidate ports, drawn at random in the range, outside those the panel has
 * already reserved. At random rather than the first free one: two tests at the
 * same time do not fight over the same one.
 */
export function reachCandidates(
  range: PortRange,
  exclude: ReadonlySet<number>,
  count = 12,
  random: () => number = Math.random,
): number[] {
  const size = range.max - range.min + 1;
  if (size <= 0) return [];
  const picked = new Set<number>();
  for (let attempt = 0; attempt < count * 8 && picked.size < count; attempt += 1) {
    const port = range.min + Math.floor(random() * size);
    if (!exclude.has(port)) picked.add(port);
  }
  // A narrow, almost full range: we go through it rather than gamble.
  if (picked.size === 0 && size <= 4096) {
    for (let port = range.min; port <= range.max && picked.size < count; port += 1) {
      if (!exclude.has(port)) picked.add(port);
    }
  }
  return [...picked];
}

/** `::ffff:10.0.0.2` (IPv4 seen by an IPv6 listener) → `10.0.0.2`. */
export function normalizePeer(peer: string | null | undefined): string | null {
  const value = peer?.trim() ?? '';
  if (!value) return null;
  return value.replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i, '$1');
}

/**
 * What the connection says. `curl` returns 7 when the connection is refused, 28
 * when nothing came back in time; a body without the token comes from someone
 * else.
 */
export function interpretReach(input: {
  curlCode: number;
  body: string;
  token: string;
  address: string;
  port: number;
  proxyName: string;
  language?: UiLanguage;
}): { failure: ReachFailure | null; detail: string } {
  const say = proxySay(input.language ?? 'fr');
  const where = `${input.address}:${input.port}`;
  const proxy = input.proxyName;
  if (input.curlCode === 0 && input.body.includes(input.token)) {
    return { failure: null, detail: say('reach.ok', { proxy, where }) };
  }
  if (input.curlCode === 0) {
    return { failure: 'mismatch', detail: say('reach.elsewhere', { where }) };
  }
  if (input.curlCode === 52 || input.curlCode === 56) {
    return { failure: 'mismatch', detail: say('reach.cutOff', { where }) };
  }
  if (input.curlCode === 7) {
    return { failure: 'refused', detail: say('reach.refused', { where, proxy }) };
  }
  if (input.curlCode === 28) {
    return {
      failure: 'timeout',
      detail: say('reach.timeout', { where, seconds: CONNECT_TIMEOUT_S, proxy }),
    };
  }
  return {
    failure: 'error',
    detail: say('reach.error', { proxy, where, code: input.curlCode }),
  };
}

// ─── the listener ────────────────────────────────────────────────────────────

/**
 * A listener for one useful connection: it answers the token to whoever asks
 * for it, notes where it came from, and stops. Anything else gets a 404, and
 * the wait is bounded. In python3, otherwise in perl (IPv4 only), otherwise
 * with `nc` — BusyBox, traditional or OpenBSD: an Alpine often has only that.
 * The last one answers the first connection without reading the request or
 * noting the arrival: the token is enough to prove it is this machine.
 */
const LISTENER_PY = `import socket, sys
host, port, token, out = sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4]
s = socket.socket(socket.AF_INET6 if ':' in host else socket.AF_INET, socket.SOCK_STREAM)
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind((host, port))
s.listen(4)
s.settimeout(${LISTENER_LIFETIME_S})
try:
    while True:
        c, peer = s.accept()
        c.settimeout(5)
        try:
            first = c.recv(2048).decode('latin-1').split('\\r\\n', 1)[0]
        except Exception:
            first = ''
        if ('/' + token) in first:
            c.sendall(('HTTP/1.0 200 OK\\r\\nContent-Type: text/plain\\r\\nConnection: close\\r\\n\\r\\n' + token + '\\n').encode())
            c.close()
            with open(out, 'w') as f:
                f.write(peer[0] + '\\n')
            break
        c.sendall(b'HTTP/1.0 404 Not Found\\r\\nConnection: close\\r\\n\\r\\n')
        c.close()
except socket.timeout:
    pass
`;

const LISTENER_PL = `use strict; use IO::Socket::INET;
my ($host, $port, $token, $out) = @ARGV;
my $s = IO::Socket::INET->new(LocalAddr => $host, LocalPort => $port, Listen => 4, ReuseAddr => 1, Proto => 'tcp') or exit 3;
$SIG{ALRM} = sub { exit 0 }; alarm ${LISTENER_LIFETIME_S};
while (my $c = $s->accept) {
  my $line = <$c>; $line = '' unless defined $line;
  if (index($line, "/$token") >= 0) {
    print $c "HTTP/1.0 200 OK\\r\\nContent-Type: text/plain\\r\\nConnection: close\\r\\n\\r\\n$token\\n";
    my $peer = $c->peerhost; close $c;
    open(my $f, '>', $out) or exit 4; print $f "$peer\\n"; close $f; exit 0;
  }
  print $c "HTTP/1.0 404 Not Found\\r\\nConnection: close\\r\\n\\r\\n"; close $c;
}
`;

const LISTENER_SH = `port=$2; token=$3
to=''; command -v timeout >/dev/null 2>&1 && to='timeout ${LISTENER_LIFETIME_S}'
reply() { printf 'HTTP/1.0 200 OK\\r\\nContent-Type: text/plain\\r\\nContent-Length: %s\\r\\nConnection: close\\r\\n\\r\\n%s\\n' "$((\${#token} + 1))" "$token"; }
# \`nc -l -p\` : BusyBox et traditionnel ; \`nc -l <port>\` : OpenBSD.
reply | $to nc -l -p "$port" >/dev/null 2>&1 || reply | $to nc -l "$port" >/dev/null 2>&1
`;

function base64(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}

// ─── the test ────────────────────────────────────────────────────────────────

export async function checkReach(input: {
  /** Where we test from: the proxy's machine (`sshReachOrigin`), or the remote proxy. */
  origin: ReachOrigin;
  /** A session to the served machine. */
  served: TargetContext;
  /** The served machine's address, as seen from the proxy's. */
  address: string;
  /** The range where the served machine's applications are published. */
  portRange: PortRange;
  /** The ports the panel has already reserved on the served machine. */
  reserved?: ReadonlySet<number>;
  onLog?: LogSink;
}): Promise<ReachResult> {
  const { origin, served, address } = input;
  const onLog = input.onLog ?? (() => {});
  const proxyName = origin.name;
  const say = proxySay(served.language);
  const base: ReachResult = {
    ok: false,
    address,
    port: null,
    routeSource: null,
    observedSource: null,
    bindable: false,
    failure: null,
    detail: '',
  };

  // 1. The route, from the proxy's machine — when it is known.
  const found = await origin.routeSource(address);
  if (found === null) {
    return {
      ...base,
      failure: 'no_route',
      detail: say('reach.noRoute', { proxy: proxyName, address }),
    };
  }
  const routeSource = found ?? null;
  if (routeSource) {
    onLog(say('reach.route', { proxy: proxyName, address, source: routeSource }));
  }

  // 2. Does the address belong to the served machine? We then listen on it alone.
  const addresses = await exec(
    served.sshSession,
    "ip -o addr show 2>/dev/null | awk '{print $4}' | cut -d/ -f1",
    { timeout: SHORT_MS },
  );
  const bindable = addresses.stdout
    .split('\n')
    .map((line) => line.trim())
    .includes(address);
  const withRoute: ReachResult = { ...base, routeSource, bindable };

  // 3. A free port in the range: neither reserved by the panel, nor already listening.
  const listening = await listeningPorts(served);
  const taken = new Set<number>([...(input.reserved ?? []), ...(listening ?? [])]);
  const candidates = reachCandidates(input.portRange, taken);
  if (candidates.length === 0) {
    return {
      ...withRoute,
      failure: 'no_listener',
      detail: say('reach.noFreePort', { min: input.portRange.min, max: input.portRange.max }),
    };
  }

  const attempt = async (port: number): Promise<ReachResult> => {
    const token = randomBytes(8).toString('hex');
    const stem = `/tmp/pupitre-reach-${token}`;
    const listenOn = bindable ? address : address.includes(':') ? '::' : '0.0.0.0';
    let ruleAdded = false;
    try {
      // The machine's firewall must not skew the test: the port of an application
      // published by Docker or through a NodePort goes before it. For the duration of
      // the test, that port is opened — then closed.
      if ((await ufwState(served)) === 'active') {
        const opened = await exec(
          served.sshSession,
          `ufw allow ${port}/tcp comment ${shellQuote(REACH_UFW_COMMENT)}`,
          { sudo: true, timeout: SHORT_MS },
        );
        ruleAdded = opened.code === 0;
      }

      // 4. The listener, detached: it stops by itself after LISTENER_LIFETIME_S.
      const started = await exec(
        served.sshSession,
        [
          `printf '%s' '${base64(LISTENER_PY)}' | base64 -d > ${stem}.py`,
          `printf '%s' '${base64(LISTENER_PL)}' | base64 -d > ${stem}.pl`,
          `printf '%s' '${base64(LISTENER_SH)}' | base64 -d > ${stem}.sh`,
          `if command -v python3 >/dev/null 2>&1; then runner="python3 ${stem}.py";`,
          `elif command -v perl >/dev/null 2>&1 && [ "${listenOn.includes(':') ? 'v6' : 'v4'}" = v4 ]; then runner="perl ${stem}.pl";`,
          `elif command -v nc >/dev/null 2>&1; then runner="sh ${stem}.sh";`,
          `else echo none; exit 0; fi`,
          `nohup $runner ${shellQuote(listenOn)} ${port} ${token} ${stem}.peer >/dev/null 2>&1 &`,
          `pid=$!; echo "$pid" > ${stem}.pid`,
          // Ready when the port listens; dead if it could not bind to it.
          `for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do`,
          `  kill -0 "$pid" 2>/dev/null || { echo dead; exit 0; }`,
          `  (ss -tlnH 2>/dev/null || netstat -tln 2>/dev/null) | grep -qE '[:.]${port}[[:space:]]' && { echo up; exit 0; }`,
          `  sleep 0.2;`,
          `done; echo unsure`,
        ].join('\n'),
        { timeout: SHORT_MS },
      );
      const state = firstLine(started.stdout);
      if (state === 'none') {
        return {
          ...withRoute,
          ok: null,
          port,
          detail: say('reach.noTool', { target: served.target.name }),
        };
      }
      if (state === 'dead') {
        return {
          ...withRoute,
          port,
          failure: 'no_listener',
          detail: say('reach.cannotListen', {
            address: listenOn,
            port,
            target: served.target.name,
          }),
        };
      }

      // 5. The connection, from the proxy.
      const connect = await origin.connect(address, port, token);
      const verdict = interpretReach({
        curlCode: connect.curlCode,
        body: connect.body,
        token,
        address,
        port,
        proxyName,
        language: served.language,
      });

      // 6. Where the connection arrived from, as seen from here.
      const peer = await exec(served.sshSession, `cat ${stem}.peer 2>/dev/null || true`, {
        timeout: SHORT_MS,
      });
      const observedSource =
        verdict.failure === null ? normalizePeer(firstLine(peer.stdout)) : null;
      if (observedSource && routeSource && observedSource !== routeSource) {
        onLog(say('reach.nat', { target: served.target.name, source: observedSource }));
      }
      // Neither the listener (nc does not note it) nor the route (a remote proxy does
      // not tell it): we do not know where it arrives from, and we say so — the
      // applications' port cannot be opened to it alone.
      const unknownSource = verdict.failure === null && !observedSource && !routeSource;
      return {
        ...withRoute,
        ok: verdict.failure === null,
        port,
        observedSource,
        failure: verdict.failure,
        detail: unknownSource
          ? say('reach.unknownSource', { detail: verdict.detail, target: served.target.name })
          : verdict.detail,
      };
    } finally {
      await exec(
        served.sshSession,
        `kill "$(cat ${stem}.pid 2>/dev/null)" 2>/dev/null; rm -f ${stem}.py ${stem}.pl ${stem}.sh ${stem}.pid ${stem}.peer; true`,
        { timeout: SHORT_MS },
      ).catch(() => undefined);
      if (ruleAdded) {
        await exec(served.sshSession, `ufw --force delete allow ${port}/tcp`, {
          sudo: true,
          timeout: SHORT_MS,
        }).catch(() => undefined);
      }
    }
  };

  let result = await attempt(candidates[0]!);
  // A test port can be hijacked by a service Pupitre does not know — another
  // deployment's NodePort: another application answers. We try elsewhere before
  // concluding; an address that really leads elsewhere fails twice.
  if (result.failure === 'mismatch' && candidates[1] !== undefined) {
    onLog(say('reach.retry', { detail: result.detail }));
    result = await attempt(candidates[1]);
  }
  return result;
}
