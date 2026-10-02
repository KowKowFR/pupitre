'use client';

import { twoFactorClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';

/** Client Better Auth pour les composants React. Même origine que le panel. */
const authClient = createAuthClient({
  basePath: '/api/auth',
  // Pas de `adminClient()` : les routes d'administration de Better Auth sont
  // fermées (voir `app/api/auth/[...all]/route.ts`) ; l'écran passe par
  // `/api/admin/*`.
  plugins: [twoFactorClient()],
});

export const {
  signIn,
  signUp,
  signOut,
  twoFactor,
  // Demande d'un lien de réinitialisation, et consommation de ce lien. Les deux
  // sont ceux de Better Auth : la génération du jeton, son usage unique, son
  // échéance et l'anti-énumération de la demande sont à lui, pas à nous.
  requestPasswordReset,
  resetPassword,
} = authClient;
