import { randomBytes } from 'node:crypto';
import { listeningPorts } from '../drivers/listening.js';
import type { LogSink, TargetContext } from '../drivers/types.js';
import { ufwState, UFW_MARKER } from '../drivers/ufw.js';
import type { PortRange } from '../ports.js';
import { exec } from '../ssh/client.js';
import type { ReachAttempt } from './types.js';
import { firstLine, shellQuote } from '../shell.js';

/**
 * La machine d'un proxy joint-elle vraiment celle qu'il doit servir ?
 *
 * Une route qui existe ou un ping qui répond ne le prouvent pas : un groupe de
 * sécurité de l'hébergeur, un pare-feu ou une adresse qui n'est pas la bonne
 * laissent passer l'un et bloquent l'application. On éprouve donc le chemin
 * même qu'emprunteront les visiteurs :
 *
 *   1. depuis la machine du proxy, la route vers l'adresse donnée ;
 *   2. sur la machine servie, un écouteur éphémère sur un port libre **de la
 *      plage des applications** — c'est là que le driver publiera ;
 *   3. depuis la machine du proxy, une connexion à `adresse:port`, qui doit
 *      rapporter un jeton tiré pour l'occasion : c'est bien cette machine qui
 *      a répondu, pas une autre derrière la même adresse ;
 *   4. l'écouteur note l'adresse d'où la connexion est arrivée — celle à qui
 *      ouvrir le port, NAT compris.
 *
 * Rien ne reste : l'écouteur s'arrête de lui-même, la règle de pare-feu posée
 * pour le test est retirée. Aucun runtime n'intervient : c'est la machine qu'on
 * éprouve, pas Docker ni Kubernetes.
 */

/** Ce que l'écouteur attend avant de s'arrêter de lui-même. */
const LISTENER_LIFETIME_S = 30;
/** Le délai laissé à la connexion depuis la machine du proxy. */
const CONNECT_TIMEOUT_S = 5;
const SHORT_MS = 30_000;
/** Le commentaire de la règle ufw du test : reconnaissable, et retirée aussitôt. */
const REACH_UFW_COMMENT = `${UFW_MARKER}:reach`;

export type ReachFailure =
  /** La machine du proxy n'a aucune route vers l'adresse. */
  | 'no_route'
  /** Aucun port libre dans la plage, ou aucun moyen d'écouter sur la machine servie. */
  | 'no_listener'
  /** Rien n'est revenu : un pare-feu jette les paquets, ou l'adresse ne mène nulle part. */
  | 'timeout'
  /** L'adresse répond mais refuse le port : pare-feu en REJECT, ou autre machine. */
  | 'refused'
  /** Quelqu'un a répondu, mais pas l'écouteur posé : ce n'est pas cette machine. */
  | 'mismatch'
  | 'error';

export type ReachResult = {
  /** `null` : pas pu éprouver — ni python3, ni perl, ni nc sur la machine servie. */
  ok: boolean | null;
  address: string;
  /** Le port éprouvé, pris dans la plage des applications. */
  port: number | null;
  /** L'adresse de la machine du proxy vers celle-ci, selon sa table de routage. */
  routeSource: string | null;
  /** L'adresse d'où la connexion est arrivée, vue de la machine servie. */
  observedSource: string | null;
  /** L'adresse donnée est l'une de celles de la machine servie : on peut y publier. */
  bindable: boolean;
  failure: ReachFailure | null;
  /** La phrase à montrer : ce qui a été éprouvé, ou ce qui bloque. */
  detail: string;
};

/**
 * D'où l'on éprouve le chemin : la machine du proxy, par SSH — ou, pour un
 * proxy distant que Pupitre ne pilote pas, le proxy lui-même, qui relaie la
 * requête comme il relaiera les visiteurs.
 */
export type ReachOrigin = {
  /** Comment le nommer dans les messages : la machine, ou la connexion. */
  name: string;
  /**
   * L'adresse de départ vers `address` selon la table de routage. `null` :
   * aucune route ; `undefined` : sans objet — un proxy distant ne la dit pas.
   */
  routeSource(address: string): Promise<string | null | undefined>;
  /** `GET /{token}` vers `address:port`, rendu dans le vocabulaire de curl. */
  connect(address: string, port: number, token: string): Promise<ReachAttempt>;
};

/** Éprouver depuis la machine du proxy : `ip route get`, puis `curl`. */
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
        // Le code de curl, pris aussitôt : celui d'un `echo` ne dirait rien.
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

/** L'adresse d'arrivée à retenir pour le pare-feu : celle observée, sinon celle de la route. */
export function reachSource(result: ReachResult): string | null {
  return result.observedSource ?? result.routeSource;
}

// ─── les morceaux qui se testent seuls ───────────────────────────────────────

/**
 * Des ports candidats, tirés au hasard dans la plage, hors de ceux que le
 * panel a déjà réservés. Au hasard plutôt que le premier libre : deux tests en
 * même temps ne se disputent pas le même.
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
  // Une plage étroite et presque pleine : on la parcourt plutôt que de jouer.
  if (picked.size === 0 && size <= 4096) {
    for (let port = range.min; port <= range.max && picked.size < count; port += 1) {
      if (!exclude.has(port)) picked.add(port);
    }
  }
  return [...picked];
}

/** `::ffff:10.0.0.2` (IPv4 vue par un écouteur IPv6) → `10.0.0.2`. */
export function normalizePeer(peer: string | null | undefined): string | null {
  const value = peer?.trim() ?? '';
  if (!value) return null;
  return value.replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i, '$1');
}

/**
 * Ce que dit la connexion. `curl` rend 7 quand la connexion est refusée, 28
 * quand rien n'est revenu dans le délai ; un corps sans le jeton vient de
 * quelqu'un d'autre.
 */
export function interpretReach(input: {
  curlCode: number;
  body: string;
  token: string;
  address: string;
  port: number;
  proxyName: string;
}): { failure: ReachFailure | null; detail: string } {
  const where = `${input.address}:${input.port}`;
  if (input.curlCode === 0 && input.body.includes(input.token)) {
    return {
      failure: null,
      detail: `connexion ouverte depuis « ${input.proxyName} » vers ${where}`,
    };
  }
  if (input.curlCode === 0) {
    return {
      failure: 'mismatch',
      detail: `${where} a répondu, mais ce n'est pas cette machine — l'adresse mène ailleurs (NAT, autre serveur ?)`,
    };
  }
  if (input.curlCode === 52 || input.curlCode === 56) {
    return {
      failure: 'mismatch',
      detail: `${where} accepte la connexion puis la coupe sans réponse — ce n'est pas cette machine qui répond (proxy transparent, NAT, autre serveur ?)`,
    };
  }
  if (input.curlCode === 7) {
    return {
      failure: 'refused',
      detail: `${where} refuse la connexion depuis « ${input.proxyName} » — un pare-feu la rejette, ou l'adresse n'est pas celle de cette machine`,
    };
  }
  if (input.curlCode === 28) {
    return {
      failure: 'timeout',
      detail: `aucune réponse de ${where} en ${CONNECT_TIMEOUT_S} s depuis « ${input.proxyName} » — un pare-feu ou le groupe de sécurité de l'hébergeur bloque sans doute le passage`,
    };
  }
  return {
    failure: 'error',
    detail: `connexion impossible de « ${input.proxyName} » vers ${where} (curl code ${input.curlCode})`,
  };
}

// ─── l'écouteur ──────────────────────────────────────────────────────────────

/**
 * Un écouteur d'une connexion utile : il répond le jeton à qui le demande, note
 * d'où elle vient, et s'arrête. Ce qui arrive d'autre reçoit un 404, et
 * l'attente est bornée. En python3, sinon en perl (IPv4 seulement), sinon avec
 * `nc` — BusyBox, traditionnel ou OpenBSD : une Alpine n'a souvent que lui.
 * Ce dernier répond à la première connexion sans lire la demande ni noter
 * l'arrivée : le jeton suffit à prouver que c'est cette machine.
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

// ─── l'épreuve ───────────────────────────────────────────────────────────────

export async function checkReach(input: {
  /** D'où l'on éprouve : la machine du proxy (`sshReachOrigin`), ou le proxy distant. */
  origin: ReachOrigin;
  /** Une session vers la machine servie. */
  served: TargetContext;
  /** L'adresse de la machine servie, vue de celle du proxy. */
  address: string;
  /** La plage où les applications de la machine servie sont publiées. */
  portRange: PortRange;
  /** Les ports que le panel a déjà réservés sur la machine servie. */
  reserved?: ReadonlySet<number>;
  onLog?: LogSink;
}): Promise<ReachResult> {
  const { origin, served, address } = input;
  const onLog = input.onLog ?? (() => {});
  const proxyName = origin.name;
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

  // 1. La route, depuis la machine du proxy — quand on la connaît.
  const found = await origin.routeSource(address);
  if (found === null) {
    return {
      ...base,
      failure: 'no_route',
      detail: `« ${proxyName} » n'a aucune route vers ${address}`,
    };
  }
  const routeSource = found ?? null;
  if (routeSource) onLog(`route de « ${proxyName} » vers ${address} : depuis ${routeSource}`);

  // 2. L'adresse est-elle à la machine servie ? On écoute alors sur elle seule.
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

  // 3. Un port libre de la plage : ni réservé par le panel, ni déjà en écoute.
  const listening = await listeningPorts(served);
  const taken = new Set<number>([...(input.reserved ?? []), ...(listening ?? [])]);
  const candidates = reachCandidates(input.portRange, taken);
  if (candidates.length === 0) {
    return {
      ...withRoute,
      failure: 'no_listener',
      detail: `aucun port libre dans ${input.portRange.min}-${input.portRange.max} pour éprouver la connexion`,
    };
  }

  const attempt = async (port: number): Promise<ReachResult> => {
    const token = randomBytes(8).toString('hex');
    const stem = `/tmp/pupitre-reach-${token}`;
    const listenOn = bindable ? address : address.includes(':') ? '::' : '0.0.0.0';
    let ruleAdded = false;
    try {
      // Le pare-feu de la machine ne doit pas fausser l'épreuve : le port d'une
      // application publiée par Docker ou par un NodePort passe avant lui. Le
      // temps du test, ce port-là est ouvert — puis refermé.
      if ((await ufwState(served)) === 'active') {
        const opened = await exec(
          served.sshSession,
          `ufw allow ${port}/tcp comment ${shellQuote(REACH_UFW_COMMENT)}`,
          { sudo: true, timeout: SHORT_MS },
        );
        ruleAdded = opened.code === 0;
      }

      // 4. L'écouteur, détaché : il s'arrête seul au bout de LISTENER_LIFETIME_S.
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
          // Prêt quand le port écoute ; mort s'il n'a pas pu s'y attacher.
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
          detail: `ni python3, ni perl, ni nc sur « ${served.target.name} » : la connexion n'a pas pu être éprouvée, seule la route l'a été`,
        };
      }
      if (state === 'dead') {
        return {
          ...withRoute,
          port,
          failure: 'no_listener',
          detail: `impossible d'écouter sur ${listenOn}:${port} sur « ${served.target.name} »`,
        };
      }

      // 5. La connexion, depuis le proxy.
      const connect = await origin.connect(address, port, token);
      const verdict = interpretReach({
        curlCode: connect.curlCode,
        body: connect.body,
        token,
        address,
        port,
        proxyName,
      });

      // 6. D'où la connexion est arrivée, vue d'ici.
      const peer = await exec(served.sshSession, `cat ${stem}.peer 2>/dev/null || true`, {
        timeout: SHORT_MS,
      });
      const observedSource =
        verdict.failure === null ? normalizePeer(firstLine(peer.stdout)) : null;
      if (observedSource && routeSource && observedSource !== routeSource) {
        onLog(`arrivée vue de « ${served.target.name} » : ${observedSource} (NAT entre les deux)`);
      }
      // Ni l'écouteur (nc ne la note pas) ni la route (un proxy distant ne la
      // dit pas) : on ne sait pas d'où il arrive, et on le dit — le port des
      // applications ne pourra pas être ouvert à lui seul.
      const unknownSource = verdict.failure === null && !observedSource && !routeSource;
      return {
        ...withRoute,
        ok: verdict.failure === null,
        port,
        observedSource,
        failure: verdict.failure,
        detail: unknownSource
          ? `${verdict.detail} — d'où il arrive n'a pas pu être relevé (ni python3 ni perl sur « ${served.target.name} ») : le port des applications ne sera pas restreint au proxy`
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
  // Un port d'essai peut être détourné par un service que Pupitre ne connaît
  // pas — le NodePort d'un autre déploiement : une autre application répond.
  // On réessaie ailleurs avant de conclure ; une adresse qui mène vraiment
  // ailleurs échoue deux fois.
  if (result.failure === 'mismatch' && candidates[1] !== undefined) {
    onLog(`${result.detail} — nouvel essai sur un autre port`);
    result = await attempt(candidates[1]);
  }
  return result;
}
