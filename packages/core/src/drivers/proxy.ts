import { exec, upload } from '../ssh/client.js';
import { stringify } from 'yaml';
import type { AppSpec } from '../spec/index.js';
import type { DriverContext, LogSink, RuntimeKind } from './types.js';

/**
 * Publication d'une application derrière un reverse proxy.
 *
 * Troisième abstraction du projet, au même titre que `DeploymentDriver` et
 * `Scanner` : ajouter BunkerWeb doit se faire en ajoutant une classe ici.
 */

export type ProxyKind = 'traefik' | 'bunkerweb';

export type ProxyRegistration = {
  /** URL publique. `null` = rien à publier, l'étape sera marquée `skipped`. */
  url: string | null;
  detail: string;
};

export interface ProxyProvider {
  readonly kind: ProxyKind;

  /**
   * Publie l'application. Retourne `url: null` quand il n'y a rien à router —
   * typiquement une AppSpec sans `ingress.host`, exposée par port seul.
   */
  register(
    ctx: DriverContext,
    input: { port: number | null; runtime: RuntimeKind },
    onLog: LogSink,
  ): Promise<ProxyRegistration>;

  unregister(ctx: DriverContext, onLog: LogSink): Promise<void>;
}

/** Échappement POSIX en quotes simples. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Traefik, via son fournisseur « file ».
 *
 * Le provider dépose un fichier de configuration dynamique dans le répertoire
 * surveillé par Traefik. Il **ne déploie pas Traefik** : il suppose qu'un
 * Traefik tourne déjà sur la cible et surveille `{rootPath}/proxy/dynamic`.
 * Sans `ingress.host`, il n'y a pas de route à créer : on ne publie rien.
 */
export class TraefikProvider implements ProxyProvider {
  readonly kind = 'traefik' as const;

  private dynamicPath(ctx: DriverContext): string {
    return `${ctx.target.rootPath}/proxy/dynamic`;
  }

  private configPath(ctx: DriverContext): string {
    return `${this.dynamicPath(ctx)}/${ctx.appSlug}.yml`;
  }

  async register(
    ctx: DriverContext,
    input: { port: number | null; runtime: RuntimeKind },
    onLog: LogSink,
  ): Promise<ProxyRegistration> {
    const host = ctx.spec.ingress?.host;
    if (!host) {
      return {
        url: null,
        detail: "aucun ingress.host dans l'AppSpec — rien à router",
      };
    }
    if (input.port === null) {
      return {
        url: null,
        detail: "aucun port publié — le service n'est pas joignable par le proxy",
      };
    }

    const tls = ctx.spec.ingress?.tls === true;
    const router = `${ctx.appSlug}-router`;
    const service = `${ctx.appSlug}-service`;

    const config = {
      http: {
        routers: {
          [router]: {
            rule: `Host(\`${host}\`)`,
            service,
            entryPoints: [tls ? 'websecure' : 'web'],
            ...(tls ? { tls: { certResolver: 'default' } } : {}),
          },
        },
        services: {
          [service]: {
            loadBalancer: {
              servers: [{ url: `http://127.0.0.1:${input.port}` }],
            },
          },
        },
      },
    };

    const body =
      `# Généré par Pupitre pour ${ctx.appSlug} — ne pas éditer.\n` +
      stringify(config, { lineWidth: 0 });

    await exec(ctx.sshSession, `mkdir -p ${shellQuote(this.dynamicPath(ctx))}`, {
      timeout: 30_000,
    });
    await upload(ctx.sshSession, Buffer.from(body, 'utf8'), this.configPath(ctx));

    onLog(`route Traefik écrite : ${this.configPath(ctx)}`);

    return {
      url: `${tls ? 'https' : 'http'}://${host}`,
      detail: `${host} → 127.0.0.1:${input.port}`,
    };
  }

  async unregister(ctx: DriverContext, onLog: LogSink): Promise<void> {
    await exec(ctx.sshSession, `rm -f ${shellQuote(this.configPath(ctx))}`, {
      timeout: 30_000,
    });
    onLog(`route Traefik retirée : ${this.configPath(ctx)}`);
  }
}

const registry: Record<ProxyKind, () => ProxyProvider> = {
  traefik: () => new TraefikProvider(),
  bunkerweb: () => {
    throw new Error('Le provider BunkerWeb est prévu en P1');
  },
};

export function getProxyProvider(kind: ProxyKind): ProxyProvider {
  return registry[kind]();
}

/** Une AppSpec sans domaine n'a rien à publier derrière un proxy. */
export function needsProxy(spec: AppSpec): boolean {
  return Boolean(spec.ingress?.host);
}
