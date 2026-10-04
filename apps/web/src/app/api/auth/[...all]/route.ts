import { logAudit } from '@pupitre/db';
import { NextResponse } from 'next/server';
import { auth as messages } from '@/i18n/messages/auth';
import { getT } from '@/i18n/server';
import { getAuth, getSession, isSignupOpen } from '@/lib/auth';
import { clientIp } from '@/lib/http';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SIGN_IN = '/api/auth/sign-in/email';
/**
 * The administration routes of Better Auth's `admin` plugin: listing, creating,
 * banning, deleting accounts, changing a password, impersonating someone.
 * Pupitre has its own administration API (`/api/admin/*`), which goes through
 * `requirePermission()`, holds its guardrails and writes to the log; these would
 * do none of that. They are closed. The server keeps the use of the plugin
 * (`getAuth().api.createUser`…), which does not go through HTTP.
 */
const ADMIN_PREFIX = '/api/auth/admin/';
const SIGN_UP = '/api/auth/sign-up/email';
const SIGN_OUT = '/api/auth/sign-out';
/** Second factor: sign-in only completes here when the account carries one. */
const VERIFY_TOTP = '/api/auth/two-factor/verify-totp';
const VERIFY_BACKUP_CODE = '/api/auth/two-factor/verify-backup-code';
/**
 * The rest of the `twoFactor` plugin — enabling, disabling, regenerating the
 * backup codes — goes through `/api/account/two-factor/*`, which writes to the
 * log and refuses to remove a second factor the role requires. Open here, these
 * routes would bypass both: only the sign-in's two verifications stay reachable.
 */
const TWO_FACTOR_PREFIX = '/api/auth/two-factor/';
/** The identity provider's return. A success is traced by Better Auth (`afterSsoSignIn`). */
const SSO_CALLBACK = '/api/auth/callback/';

/** Reads a JSON body without breaking if it is not one. */
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
 * All the Better Auth requests go through here. The sensitive events (sign-in,
 * sign-out, sign-up) are traced through `logAudit()`.
 */
async function handle(request: Request): Promise<Response> {
  const path = new URL(request.url).pathname;
  const ip = clientIp(request);
  const isSecondFactor = path === VERIFY_TOTP || path === VERIFY_BACKUP_CODE;
  const isAudited = path === SIGN_IN || path === SIGN_UP || path === SIGN_OUT || isSecondFactor;

  if (path.startsWith(ADMIN_PREFIX)) {
    await logAudit({
      action: 'auth.admin_route.refused',
      resourceType: 'request',
      resourceId: path.slice(ADMIN_PREFIX.length) || null,
      after: { method: request.method },
      ip,
    });
    return NextResponse.json({ error: { code: 'NOT_FOUND' } }, { status: 404 });
  }

  if (path.startsWith(TWO_FACTOR_PREFIX) && !isSecondFactor) {
    await logAudit({
      action: 'auth.two_factor_route.refused',
      resourceType: 'request',
      resourceId: path.slice(TWO_FACTOR_PREFIX.length) || null,
      after: { method: request.method },
      ip,
    });
    return NextResponse.json({ error: { code: 'NOT_FOUND' } }, { status: 404 });
  }

  // Public sign-up is refused before even reaching Better Auth.
  if (path === SIGN_UP && request.method === 'POST' && !(await isSignupOpen())) {
    const attempt = await safeJson(request.clone());
    await logAudit({
      action: 'auth.signup.blocked',
      resourceType: 'user',
      resourceId: asString(attempt.email),
      after: { reason: 'signup_disabled' },
      ip,
    });
    // This refusal does not go through `apiRoute()` — it is written by hand to keep
    // Better Auth's error shape. So the language is read here.
    const t = await getT(messages);
    return NextResponse.json(
      {
        error: { code: 'SIGNUP_DISABLED', message: t('signup.closed.api') },
      },
      { status: 403 },
    );
  }

  // A provider return that fails goes back to sign-in with `?error=`: it is read
  // there, for lack of an account to attribute it to.
  if (path.startsWith(SSO_CALLBACK) && request.method === 'GET') {
    const response = await getAuth().handler(request);
    const location = response.headers.get('location');
    const error = location ? new URL(location, request.url).searchParams.get('error') : null;
    if (error) {
      await logAudit({
        action: 'auth.sso.login.failed',
        resourceType: 'session',
        resourceId: null,
        after: { error, status: response.status },
        ip,
      });
    }
    return response;
  }

  if (!isAudited || request.method !== 'POST') {
    return getAuth().handler(request);
  }

  // Sign-out erases the session: we identify the actor before the call.
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
    // A 200 is not a sign-in: when a second factor is armed, Better Auth answers
    // `twoFactorRedirect` without setting a session. Tracing that as a successful
    // sign-in would lie to the log.
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
      logger.warn({ email: attemptedEmail, ip, status: response.status }, 'sign-in refused');
    }
  } else if (isSecondFactor) {
    // The code itself never enters the log, any more than the secret.
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
      logger.warn({ ip, method, status: response.status }, 'second factor refused');
    }
  } else if (path === SIGN_UP) {
    // The `user.created` line is written by the Better Auth hook; here we trace the
    // sign-up itself, with the new user as actor.
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
