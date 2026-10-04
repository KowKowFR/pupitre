'use client';

import { twoFactorClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';

/** The Better Auth client for React components. The same origin as the panel. */
const authClient = createAuthClient({
  basePath: '/api/auth',
  // No `adminClient()`: Better Auth's administration routes are closed (see
  // `app/api/auth/[...all]/route.ts`); the screen goes through `/api/admin/*`.
  plugins: [twoFactorClient()],
});

export const {
  signIn,
  signUp,
  signOut,
  twoFactor,
  // Asking for a reset link, and consuming that link. Both are Better Auth's: the
  // token's generation, its single use, its expiry and the request's
  // anti-enumeration are its own, not ours.
  requestPasswordReset,
  resetPassword,
} = authClient;
