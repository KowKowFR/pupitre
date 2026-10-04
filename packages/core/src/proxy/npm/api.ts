import { assertEgressAllowed, EgressRefusedError } from '../../egress.js';
import type { UiLanguage } from '../../i18n.js';
import { ProxyError } from '../types.js';
import { npmSay, type NpmSay } from './messages.js';

/**
 * Nginx Proxy Manager's API, reduced to what Pupitre uses: sign in with an
 * account, read and set hosts, request and remove certificates.
 *
 * It is the API its own interface uses (`/api`, a one-day JWT token). The shapes
 * below follow its schema (`backend/schema`) in 2.16.
 */

const REQUEST_TIMEOUT_MS = 15_000;
/** A certificate request waits for Let's Encrypt — HTTP-01 challenge included. */
const CERTIFICATE_TIMEOUT_MS = 240_000;

/** Pupitre's mark on a host it set up, stored in its `meta`. */
export type NpmMark = {
  /** The application, its slug. */
  app?: string;
  /** The served machine, when the proxy serves several (`ProxyRouteSet.scope`). */
  scope?: string | null;
  /** The certificate Pupitre requested for this host — to remove with it. */
  certificate?: number | null;
  /** A link test's host: ephemeral. */
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

/** An NPM error: its message, as it gives it. */
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
    if (error instanceof EgressRefusedError) {
      throw new NpmApiError(error.describe(options.language ?? 'fr'), step, 0);
    }
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

/** Does the API answer, and which version? Without an account. */
export function npmHealth(base: string, language: UiLanguage = 'fr'): Promise<NpmHealth> {
  return call<NpmHealth>(base, 'health', 'GET', '/', { language });
}

export class NpmClient {
  private constructor(
    readonly base: string,
    private readonly token: string,
    /** The instance's language: that of this client's errors, and of what is said about them. */
    readonly language: UiLanguage,
  ) {}

  /**
   * Sign in with Pupitre's account. An account with two-factor authentication only
   * returns a challenge: Pupitre could not answer it alone — it needs an account
   * of its own, without it.
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

  /** A Let's Encrypt certificate for a name, by HTTP-01 challenge — NPM waits for issuance. */
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
