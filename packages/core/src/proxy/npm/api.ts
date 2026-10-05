import { assertEgressAllowed, EgressRefusedError } from '../../egress.js';
import type { UiLanguage } from '../../i18n.js';
import { ProxyError } from '../types.js';
import { npmSay, type NpmSay } from './messages.js';

/**
 * L'API de Nginx Proxy Manager, réduite à ce que Pupitre emploie : entrer avec
 * un compte, lire et poser des hôtes, demander et retirer des certificats.
 *
 * C'est l'API dont se sert sa propre interface (`/api`, jeton JWT d'un jour).
 * Les formes ci-dessous suivent son schéma (`backend/schema`) en 2.16.
 */

const REQUEST_TIMEOUT_MS = 15_000;
/** Une demande de certificat attend Let's Encrypt — défi HTTP-01 compris. */
const CERTIFICATE_TIMEOUT_MS = 240_000;

/** La marque de Pupitre sur un hôte qu'il a posé, rangée dans son `meta`. */
export type NpmMark = {
  /** L'application, son slug. */
  app?: string;
  /** La machine servie, quand le proxy en sert plusieurs (`ProxyRouteSet.scope`). */
  scope?: string | null;
  /** Le certificat que Pupitre a demandé pour cet hôte — à retirer avec lui. */
  certificate?: number | null;
  /** Un hôte du test d'une liaison : éphémère. */
  reach?: boolean;
};

export type NpmHost = {
  id: number;
  created_on: string;
  owner_user_id: number;
  domain_names: string[];
  forward_scheme: string;
  forward_host: string;
  forward_port: number;
  certificate_id: number;
  ssl_forced: boolean;
  http2_support: boolean;
  enabled: boolean;
  meta: Record<string, unknown> & { pupitre?: NpmMark };
};

export type NpmCertificate = {
  id: number;
  provider: string;
  nice_name: string;
  domain_names: string[];
  expires_on: string | null;
};

export type NpmUser = {
  id: number;
  email: string;
  roles: string[];
  permissions?: {
    visibility: 'all' | 'user';
    proxy_hosts: 'hidden' | 'view' | 'manage';
    certificates: 'hidden' | 'view' | 'manage';
  };
};

export type NpmHealth = {
  status: string;
  version?: { major: number; minor: number; revision: number };
};

/** Une erreur de NPM : son message, tel qu'il le donne. */
export class NpmApiError extends ProxyError {
  constructor(
    message: string,
    step: string,
    readonly status: number,
  ) {
    super(message, 'npm', step);
    this.name = 'NpmApiError';
  }
}

function reason(error: unknown, say: NpmSay): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: { code?: string; message?: string } }).cause;
    if (error.name === 'TimeoutError' || error.name === 'AbortError') return say('noAnswer');
    return cause?.code ?? cause?.message ?? error.message;
  }
  return String(error);
}

async function call<T>(
  base: string,
  step: string,
  method: string,
  path: string,
  options: { token?: string; body?: unknown; timeout?: number; language?: UiLanguage } = {},
): Promise<T> {
  const say = npmSay(options.language ?? 'fr');
  try {
    await assertEgressAllowed(base);
  } catch (error) {
    if (error instanceof EgressRefusedError) throw new NpmApiError(error.message, step, 0);
    throw error;
  }
  let response: Response;
  try {
    response = await fetch(`${base}/api${path}`, {
      method,
      headers: {
        Accept: 'application/json',
        ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      signal: AbortSignal.timeout(options.timeout ?? REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new NpmApiError(say('api.unreachable', { base, reason: reason(error, say) }), step, 0);
  }
  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const message =
      (payload as { error?: { message?: string } } | null)?.error?.message ??
      `HTTP ${response.status}`;
    throw new NpmApiError(message, step, response.status);
  }
  return payload as T;
}

/** L'API répond-elle, et quelle version ? Sans compte. */
export function npmHealth(base: string, language: UiLanguage = 'fr'): Promise<NpmHealth> {
  return call<NpmHealth>(base, 'health', 'GET', '/', { language });
}

export class NpmClient {
  private constructor(
    readonly base: string,
    private readonly token: string,
    /** La langue de l'instance : celle des erreurs de ce client, et de ce qu'on en dit. */
    readonly language: UiLanguage,
  ) {}

  /**
   * Entrer avec le compte de Pupitre. Un compte à double authentification ne
   * rend qu'un défi : Pupitre ne saurait pas y répondre seul — il lui faut un
   * compte à lui, sans elle.
   */
  static async login(
    base: string,
    email: string,
    password: string,
    language: UiLanguage = 'fr',
  ): Promise<NpmClient> {
    const say = npmSay(language);
    let answer: { token?: string; requires_2fa?: boolean };
    try {
      answer = await call(base, 'login', 'POST', '/tokens', {
        body: { identity: email, secret: password, scope: 'user' },
        language,
      });
    } catch (error) {
      if (error instanceof NpmApiError && (error.status === 401 || error.status === 400)) {
        throw new NpmApiError(
          say('login.refused', { email, detail: error.message }),
          'login',
          error.status,
        );
      }
      throw error;
    }
    if (answer.requires_2fa) {
      throw new NpmApiError(say('login.twoFactor', { email }), 'login', 401);
    }
    if (!answer.token) throw new NpmApiError(say('login.noToken'), 'login', 500);
    return new NpmClient(base, answer.token, language);
  }

  private request<T>(
    step: string,
    method: string,
    path: string,
    body?: unknown,
    timeout?: number,
  ): Promise<T> {
    return call<T>(this.base, step, method, path, {
      token: this.token,
      language: this.language,
      ...(body !== undefined ? { body } : {}),
      ...(timeout !== undefined ? { timeout } : {}),
    });
  }

  me(): Promise<NpmUser> {
    return this.request('rights', 'GET', '/users/me?expand=permissions');
  }

  hosts(): Promise<NpmHost[]> {
    return this.request('hosts', 'GET', '/nginx/proxy-hosts');
  }

  createHost(body: Record<string, unknown>): Promise<NpmHost> {
    return this.request('host', 'POST', '/nginx/proxy-hosts', body);
  }

  updateHost(id: number, body: Record<string, unknown>): Promise<NpmHost> {
    return this.request('host', 'PUT', `/nginx/proxy-hosts/${id}`, body);
  }

  async deleteHost(id: number): Promise<void> {
    await this.request('host', 'DELETE', `/nginx/proxy-hosts/${id}`);
  }

  certificates(): Promise<NpmCertificate[]> {
    return this.request('certificates', 'GET', '/nginx/certificates');
  }

  /** Un certificat Let's Encrypt pour un nom, par le défi HTTP-01 — NPM attend l'émission. */
  requestCertificate(hostname: string): Promise<NpmCertificate> {
    return this.request(
      'certificate',
      'POST',
      '/nginx/certificates',
      { provider: 'letsencrypt', domain_names: [hostname], meta: { dns_challenge: false } },
      CERTIFICATE_TIMEOUT_MS,
    );
  }

  async deleteCertificate(id: number): Promise<void> {
    await this.request('certificate', 'DELETE', `/nginx/certificates/${id}`);
  }
}
