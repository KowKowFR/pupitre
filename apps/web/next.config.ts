import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

const monorepoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The settings sections' addresses before the English migration, and today's. */
const FRENCH_SETTINGS_SLUGS: Record<string, string> = {
  identite: 'identity',
  regionalisation: 'regional',
  securite: 'security',
  connexion: 'sso',
  comptes: 'accounts',
  ia: 'ai',
  sauvegardes: 'backups',
  demarrage: 'onboarding',
};

const nextConfig: NextConfig = {
  // A single Docker image: the Next server embeds its traced dependencies.
  output: 'standalone',
  outputFileTracingRoot: monorepoRoot,
  reactStrictMode: true,
  typedRoutes: true,
  // Nothing to gain by announcing the stack: `X-Powered-By: Next.js` only helps
  // whoever looks for a flaw.
  poweredByHeader: false,
  // `pg` and `ioredis` must stay Node modules, never bundled.
  serverExternalPackages: ['pg', 'ioredis', 'bullmq', 'pino', 'ssh2', 'node-ssh'],
  /**
   * The system prompt and its fixtures are **files**, not hard-coded strings. Next
   * inlines `@pupitre/core` into its server chunks: `import.meta.url` no longer
   * designates the package there, and the tracer sees no `import` of a `.md`. So
   * they are declared explicitly. They are copied into `standalone` keeping their
   * path from `outputFileTracingRoot`, and the standalone server sits in
   * `apps/web`: `readCoreAsset()` finds them there.
   */
  outputFileTracingIncludes: {
    '/api/applications/generate': [
      '../../packages/core/src/ai/prompts/**/*.md',
      '../../packages/core/src/spec/__fixtures__/*.json',
    ],
    // `/api/health` loads the prompt too, so that its absence shows in the health
    // probe rather than in front of the first user.
    '/api/health': [
      '../../packages/core/src/ai/prompts/**/*.md',
      '../../packages/core/src/spec/__fixtures__/*.json',
    ],
    // The documentation's chapters, read at runtime by `lib/docs/content.ts`: by the
    // pages, and by the MCP endpoint's `docs` tool and resources.
    '/docs': ['./src/docs/content/**/*.md'],
    '/docs/*': ['./src/docs/content/**/*.md'],
    '/api/mcp': ['./src/docs/content/**/*.md'],
  },
  /**
   * The traceability screen is called "Logs" and lives under `/admin/logs`. The
   * `/admin/audit` path existed: it lingers in runbooks, tickets and filtered URLs
   * pasted by hand. A 308 catches it — the query parameters are kept, so a
   * filtered URL stays a filtered URL.
   *
   * The permission key, for its part, stays `audit:read`: it is data in the
   * database, not a label.
   */
  /**
   * The protection headers, on every response.
   *
   * - The panel shows in no iframe (`frame-ancestors 'none'`, and
   *   `X-Frame-Options` for browsers that do not read the CSP): a third-party page
   *   cannot cover it to make someone click "Destroy" unknowingly.
   * - The CSP stops there, on purpose: `script-src` would require nonces on the
   *   scripts Next injects, and `form-action 'self'` would break the creation of
   *   the GitHub App, which posts a real form to github.com.
   * - HSTS only has an effect over HTTPS — a browser ignores it on a plain
   *   response — and without `includeSubDomains`: the panel does not decide for
   *   the applications deployed on the neighboring subdomains.
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
      // The settings no longer have a summary: their root leads to the first tab of
      // the first group. A plain 307, before any rendering — the root page does it
      // too, but mid-stream, hence on the browser side.
      { source: '/admin/settings', destination: '/admin/settings/identity', permanent: false },
      // The settings sections had French addresses until the English migration: they
      // linger in bookmarks and runbooks. A 308 keeps the query parameters.
      ...Object.entries(FRENCH_SETTINGS_SLUGS).map(([old, slug]) => ({
        source: `/admin/settings/${old}`,
        destination: `/admin/settings/${slug}`,
        permanent: true,
      })),
      // Records live in drawers, on top of their list. The old addresses — links
      // from emails, notifications, the chat — lead there; the query parameters
      // follow (`?tab=proxy`).
      {
        source: '/applications/:id([0-9a-f-]{36})',
        destination: '/applications?app=:id',
        permanent: false,
      },
      {
        source: '/targets/:id([0-9a-f-]{36})/edit',
        destination: '/targets?target=:id&edit=1',
        permanent: false,
      },
      {
        source: '/targets/:id([0-9a-f-]{36})',
        destination: '/targets?target=:id',
        permanent: false,
      },
      {
        source: '/monitors/:id([0-9a-f-]{36})',
        destination: '/monitors?monitor=:id',
        permanent: false,
      },
      {
        source: '/deployments/:id([0-9a-f-]{36})',
        destination: '/deployments?run=:id',
        permanent: false,
      },
      { source: '/apps/:id([0-9a-f-]{36})', destination: '/apps?app=:id', permanent: false },
      // Links already sent — notification emails, the chat — carry the drawers' French
      // parameters from before the English migration. `missing` stops the loop: the
      // other query parameters are passed through, the old one included.
      {
        source: '/maintenance',
        has: [{ type: 'query', key: 'fenetre', value: '(?<id>[^&]+)' }],
        missing: [{ type: 'query', key: 'window' }],
        destination: '/maintenance?window=:id',
        permanent: false,
      },
      {
        source: '/status-pages',
        has: [{ type: 'query', key: 'annonce', value: '(?<subject>[^&]+)' }],
        missing: [{ type: 'query', key: 'announce' }],
        destination: '/status-pages?announce=:subject',
        permanent: false,
      },
      {
        source: '/domains',
        has: [{ type: 'query', key: 'domaine', value: '(?<id>[^&]+)' }],
        missing: [{ type: 'query', key: 'domain' }],
        destination: '/domains?domain=:id',
        permanent: false,
      },
    ]);
  },
};

export default nextConfig;
