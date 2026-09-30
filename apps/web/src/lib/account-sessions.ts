import 'server-only';
import { getAuth, getSession } from '@/lib/auth';
import { compactIp } from '@/lib/ip';
import { describeUserAgent } from '@/lib/user-agent';

/**
 * Une session ouverte, telle que « Mon compte » la montre.
 *
 * **Le jeton ne sort jamais d'ici.** Better Auth le renvoie avec chaque
 * session, parce que c'est lui qui la révoque ; le navigateur, lui, n'a besoin
 * que de l'identifiant — la route de fermeture retrouve le jeton côté serveur.
 */
export type AccountSession = {
  id: string;
  /** La session de la requête en cours : « celle-ci ». */
  current: boolean;
  /** « Firefox 131 · Linux », ou `null` quand l'agent n'a rien dit. */
  device: string | null;
  ipAddress: string | null;
  createdAt: string;
  /** Dernier renouvellement : à un jour près (`updateAge`), la dernière activité. */
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
 * Les sessions **encore valides** de l'appelant, la sienne d'abord, puis de
 * la plus récemment active à la plus ancienne. Better Auth écarte déjà les
 * sessions expirées.
 */
export async function listAccountSessions(headers: Headers): Promise<{
  sessions: AccountSession[];
  /** Pour la révocation seulement — jamais sérialisé vers le client. */
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
