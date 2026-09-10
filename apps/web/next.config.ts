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
  // `pg` et `ioredis` doivent rester des modules Node, jamais bundlés.
  serverExternalPackages: ['pg', 'ioredis', 'bullmq', 'pino', 'ssh2', 'node-ssh'],
  /**
   * Le prompt système et ses fixtures sont des **fichiers**, pas des chaînes en
   * dur. Next inline `@tp/core` dans ses chunks serveur : `import.meta.url` n'y
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
};

export default nextConfig;
