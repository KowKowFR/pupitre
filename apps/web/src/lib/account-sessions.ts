import 'server-only';
import { getAuth, getSession } from '@/lib/auth';
import { compactIp } from '@/lib/ip';
import { describeUserAgent } from '@/lib/user-agent';

/**
 * An open session, as "My account" shows it.
 *
 * **The token never leaves here.** Better Auth returns it with each session,
 * because it is what revokes it; the browser, for its part, only needs the
 * identifier — the closing route finds the token again on the server side.
 */
export type AccountSession = {
  id: string;
  /** The current request's session: "this one". */
  current: boolean;
  /** "Firefox 131 · Linux", or `null` when the agent said nothing. */
  device: string | null;
  ipAddress: string | null;
  createdAt: string;
  /** The last renewal: to within a day (`updateAge`), the last activity. */
  updatedAt: string;
  expiresAt: string;
};

type BetterAuthSession = {
  id: string;
  token: string;
  ipAddress?: string | null;
  userAgent?: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
  expiresAt: Date | string;
};

const iso = (value: Date | string) => new Date(value).toISOString();

/**
 * The caller's **still valid** sessions, theirs first, then from the most
 * recently active to the oldest. Better Auth already sets the expired sessions
 * aside.
 */
export async function listAccountSessions(headers: Headers): Promise<{
  sessions: AccountSession[];
  /** For revocation only — never serialized to the client. */
  tokens: Map<string, string>;
}> {
  const [current, raw] = await Promise.all([
    getSession(headers),
    getAuth().api.listSessions({ headers }) as Promise<BetterAuthSession[]>,
  ]);
  const currentId = current?.session.id ?? null;

  const tokens = new Map<string, string>();
  const sessions = raw.map((session) => {
    tokens.set(session.id, session.token);
    return {
      id: session.id,
      current: session.id === currentId,
      device: describeUserAgent(session.userAgent),
      ipAddress: compactIp(session.ipAddress),
      createdAt: iso(session.createdAt),
      updatedAt: iso(session.updatedAt),
      expiresAt: iso(session.expiresAt),
    };
  });

  sessions.sort(
    (a, b) =>
      Number(b.current) - Number(a.current) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
  );

  return { sessions, tokens };
}
