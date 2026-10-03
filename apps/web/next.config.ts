import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

const monorepoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const nextConfig: NextConfig = {
  // Une seule image Docker : le serveur Next embarque ses dépendances tracées.
  output: 'standalone',
  outputFileTracingRoot: monorepoRoot,
  reactStrictMode: true,
  typedRoutes: true,
  // Rien à gagner à annoncer la pile : `X-Powered-By: Next.js` ne sert qu'à qui cherche une faille.
  poweredByHeader: false,
  // `pg` et `ioredis` doivent rester des modules Node, jamais bundlés.
  serverExternalPackages: ['pg', 'ioredis', 'bullmq', 'pino', 'ssh2', 'node-ssh'],
  /**
   * Le prompt système et ses fixtures sont des **fichiers**, pas des chaînes en
   * dur. Next inline `@pupitre/core` dans ses chunks serveur : `import.meta.url` n'y
   * désigne plus le paquet, et le traceur ne voit aucun `import` vers un `.md`.
   * On les déclare donc explicitement. Ils sont recopiés dans `standalone` en
   * conservant leur chemin depuis `outputFileTracingRoot`, et le serveur
   * standalone se place dans `apps/web` : `readCoreAsset()` les y retrouve.
   */
  outputFileTracingIncludes: {
    '/api/applications/generate': [
      '../../packages/core/src/ai/prompts/**/*.md',
      '../../packages/core/src/spec/__fixtures__/*.json',
    ],
    // `/api/health` charge le prompt lui aussi, pour que son absence se voie
    // dans la sonde de santé plutôt que devant le premier utilisateur.
    '/api/health': [
      '../../packages/core/src/ai/prompts/**/*.md',
      '../../packages/core/src/spec/__fixtures__/*.json',
    ],
  },
  /**
   * L'écran de traçabilité s'appelle « Logs » et vit sous `/admin/logs`. Le
   * chemin `/admin/audit` a existé : il traîne dans des runbooks, des tickets et
   * des URL filtrées collées à la main. Un 308 le rattrape — les paramètres de
   * requête sont conservés, donc une URL filtrée reste une URL filtrée.
   *
   * La clé de permission, elle, reste `audit:read` : c'est une donnée en base,
   * pas un libellé.
   */
  /**
   * Les en-têtes de protection, sur toutes les réponses.
   *
   * - Le panel ne s'affiche dans aucune iframe (`frame-ancestors 'none'`, et
   *   `X-Frame-Options` pour les navigateurs qui ne lisent pas la CSP) : une
   *   page tierce ne peut pas le recouvrir pour faire cliquer à l'insu de
   *   quelqu'un sur « Détruire ».
   * - La CSP s'arrête là, volontairement : `script-src` demanderait des nonces
   *   sur les scripts que Next injecte, et `form-action 'self'` casserait la
   *   création de l'App GitHub, qui poste un vrai formulaire vers github.com.
   * - HSTS n'a d'effet qu'en HTTPS — un navigateur l'ignore sur une réponse en
   *   clair — et sans `includeSubDomains` : le panel ne décide pas pour les
   *   applications déployées sur les sous-domaines voisins.
   */
  headers() {
    return Promise.resolve([
      {
        source: '/:path*',
        headers: [
          {
            key: 'Content-Security-Policy',
            value: "frame-ancestors 'none'; base-uri 'self'; object-src 'none'",
          },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
          },
          { key: 'Strict-Transport-Security', value: 'max-age=31536000' },
        ],
      },
    ]);
  },
  redirects() {
    return Promise.resolve([
      { source: '/admin/audit', destination: '/admin/logs', permanent: true },
      // Les paramètres n'ont plus de sommaire : leur racine mène au premier
      // onglet du premier groupe. Un 307 franc, avant tout rendu — la page
      // racine le fait aussi, mais en cours de flux, donc côté navigateur.
      { source: '/admin/settings', destination: '/admin/settings/identite', permanent: false },
    ]);
  },
};

export default nextConfig;
