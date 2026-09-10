'use client';

import { adminClient, twoFactorClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';

/** Client Better Auth pour les composants React. Même origine que le panel. */
export const authClient = createAuthClient({
  basePath: '/api/auth',
  plugins: [adminClient(), twoFactorClient()],
});

export const { signIn, signUp, signOut, useSession, twoFactor } = authClient;
