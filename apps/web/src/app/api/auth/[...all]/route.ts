import { logAudit } from '@pupitre/db';
import { NextResponse } from 'next/server';
import { getAuth, getSession, isSignupOpen } from '@/lib/auth';
import { clientIp } from '@/lib/http';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SIGN_IN = '/api/auth/sign-in/email';
const SIGN_UP = '/api/auth/sign-up/email';
const SIGN_OUT = '/api/auth/sign-out';
/** Second facteur : la connexion ne s'achève qu'ici quand le compte en porte un. */
const VERIFY_TOTP = '/api/auth/two-factor/verify-totp';
const VERIFY_BACKUP_CODE = '/api/auth/two-factor/verify-backup-code';

/** Lit un corps JSON sans casser si ce n'en est pas un. */
async function safeJson(source: Request | Response): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await source.json();
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Toutes les requêtes Better Auth passent ici. Les événements sensibles
 * (connexion, déconnexion, inscription) sont tracés via `logAudit()`.
 */
async function handle(request: Request): Promise<Response> {
  const path = new URL(request.url).pathname;
  const ip = clientIp(request);
  const isSecondFactor = path === VERIFY_TOTP || path === VERIFY_BACKUP_CODE;
  const isAudited = path === SIGN_IN || path === SIGN_UP || path === SIGN_OUT || isSecondFactor;

  // L'inscription publique est refusée avant même d'atteindre Better Auth.
  if (path === SIGN_UP && request.method === 'POST' && !(await isSignupOpen())) {
    const attempt = await safeJson(request.clone());
    await logAudit({
      action: 'auth.signup.blocked',
      resourceType: 'user',
      resourceId: asString(attempt.email),
      after: { reason: 'signup_disabled' },
      ip,
    });
    return NextResponse.json(
      {
        error: {
          code: 'SIGNUP_DISABLED',
          message:
            "L'inscription publique est désactivée. Demandez un compte à un administrateur.",
        },
      },
      { status: 403 },
    );
  }

  if (!isAudited || request.method !== 'POST') {
    return getAuth().handler(request);
  }

  // La déconnexion efface la session : on identifie l'acteur avant l'appel.
  const before = path === SIGN_OUT ? await getSession(request.headers) : null;
  const probe = await safeJson(request.clone());

  const response = await getAuth().handler(request);
  const succeeded = response.status >= 200 && response.status < 300;
  const body = succeeded ? await safeJson(response.clone()) : {};
  const user =
    typeof body.user === 'object' && body.user !== null
      ? (body.user as Record<string, unknown>)
      : {};

  const attemptedEmail = asString(probe.email);

  if (path === SIGN_IN) {
    // Un 200 ne vaut pas connexion : quand un second facteur est armé, Better
    // Auth répond `twoFactorRedirect` sans poser de session. Tracer cela comme
    // une connexion réussie mentirait au journal.
    const pendingSecondFactor = succeeded && body.twoFactorRedirect === true;
    const action = pendingSecondFactor
      ? 'auth.login.two_factor_required'
      : succeeded
        ? 'auth.login.succeeded'
        : 'auth.login.failed';
    await logAudit({
      actorId: succeeded && !pendingSecondFactor ? asString(user.id) : null,
      action,
      resourceType: 'session',
      resourceId: succeeded && !pendingSecondFactor ? asString(user.id) : attemptedEmail,
      after: {
        email: attemptedEmail,
        status: response.status,
        userAgent: request.headers.get('user-agent'),
      },
      ip,
    });
    if (!succeeded) {
      logger.warn({ email: attemptedEmail, ip, status: response.status }, 'connexion refusée');
    }
  } else if (isSecondFactor) {
    // Le code lui-même n'entre jamais dans le journal, pas plus que le secret.
    const method = path === VERIFY_TOTP ? 'totp' : 'backup_code';
    await logAudit({
      actorId: succeeded ? asString(user.id) : null,
      action: succeeded ? 'auth.login.succeeded' : 'auth.two_factor.failed',
      resourceType: 'session',
      resourceId: succeeded ? asString(user.id) : null,
      after: { method, status: response.status, secondFactor: true },
      ip,
    });
    if (!succeeded) {
      logger.warn({ ip, method, status: response.status }, 'second facteur refusé');
    }
  } else if (path === SIGN_UP) {
    // La ligne `user.created` est écrite par le hook Better Auth ; ici on trace
    // l'inscription elle-même, avec le nouvel utilisateur pour acteur.
    await logAudit({
      actorId: succeeded ? asString(user.id) : null,
      action: succeeded ? 'auth.signup.succeeded' : 'auth.signup.failed',
      resourceType: 'user',
      resourceId: succeeded ? asString(user.id) : attemptedEmail,
      after: { email: attemptedEmail, status: response.status },
      ip,
    });
  } else if (path === SIGN_OUT && succeeded) {
    await logAudit({
      actorId: before?.user.id ?? null,
      action: 'auth.logout',
      resourceType: 'session',
      resourceId: before?.session.id ?? null,
      after: { email: before?.user.email ?? null },
      ip,
    });
  }

  return response;
}

export const GET = handle;
export const POST = handle;
