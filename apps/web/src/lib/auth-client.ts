'use client';

import { adminClient, twoFactorClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';

/** Client Better Auth pour les composants React. Même origine que le panel. */
export const authClient = createAuthClient({
  basePath: '/api/auth',
  plugins: [adminClient(), twoFactorClient()],
});

export const {
  signIn,
  signUp,
  signOut,
  useSession,
  twoFactor,
  // Demande d'un lien de réinitialisation, et consommation de ce lien. Les deux
  // sont ceux de Better Auth : la génération du jeton, son usage unique, son
  // échéance et l'anti-énumération de la demande sont à lui, pas à nous.
  requestPasswordReset,
  resetPassword,
} = authClient;
