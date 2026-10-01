import { appSpec, envWhen, mariadb, postgres, publicUrl, redis } from './parts.js';
import type { CatalogTemplate } from './types.js';

/**
 * Les modèles du catalogue.
 *
 * Règles de la maison, les mêmes pour tous :
 *
 * - **Une image officielle**, publiée par l'éditeur du logiciel. Tag majeur
 *   quand l'éditeur en publie un, sinon `latest` : un redéploiement prend les
 *   correctifs, jamais une version majeure qu'on n'a pas choisie — sauf là où
 *   l'éditeur ne laisse pas le choix.
 * - **Aucune commande de démarrage** : l'AppSpec n'en a pas. Une image qui ne
 *   démarre pas seule n'est pas au catalogue.
 * - **Une sonde qui répond sans compte** : la page d'accueil, ou la route de
 *   santé documentée. Une redirection vers la connexion compte comme réponse.
 * - **Les mots de passe dont on a besoin pour entrer sont demandés**, les
 *   autres sont générés (voir `askedSecrets`).
 */
export const CATALOG_TEMPLATES: readonly CatalogTemplate[] = [
  // ── Supervision ───────────────────────────────────────────────────────────
  {
    id: 'uptime-kuma',
    name: 'Uptime Kuma',
    category: 'monitoring',
    website: 'https://uptime.kuma.pet',
    summary: {
      fr: 'Sondes HTTP, TCP, DNS et ping, pages de statut publiques, alertes vers une centaine de services.',
      en: 'HTTP, TCP, DNS and ping probes, public status pages, alerts to a hundred services.',
    },
    firstRun: {
      fr: "Ouvrez l'application dès le déploiement terminé : le premier écran crée le compte administrateur.",
      en: 'Open the application as soon as it is deployed: the first screen creates the administrator account.',
    },
    askedSecrets: [],
    wantsHost: false,
    build: (params) =>
      appSpec(params, [
        {
          name: 'web',
          source: { type: 'image', ref: 'louislam/uptime-kuma:1' },
          port: 3001,
          exposed: true,
          resources: { cpuMilli: 500, memoryMi: 512 },
          healthcheck: { path: '/', intervalSec: 15, retries: 10 },
          volumes: [{ name: 'data', mountPath: '/app/data', size: '2Gi' }],
        },
      ]),
  },
  {
    id: 'grafana',
    name: 'Grafana',
    category: 'monitoring',
    website: 'https://grafana.com/oss/grafana',
    summary: {
      fr: 'Tableaux de bord et alertes sur Prometheus, Loki, PostgreSQL et des dizaines d’autres sources.',
      en: 'Dashboards and alerts over Prometheus, Loki, PostgreSQL and dozens of other sources.',
    },
    firstRun: {
      fr: 'Connectez-vous avec le compte admin et le mot de passe choisi ici.',
      en: 'Sign in with the admin account and the password chosen here.',
    },
    askedSecrets: ['GF_SECURITY_ADMIN_PASSWORD'],
    wantsHost: false,
    build: (params) =>
      appSpec(params, [
        {
          name: 'web',
          source: { type: 'image', ref: 'grafana/grafana:latest' },
          port: 3000,
          exposed: true,
          env: envWhen({ GF_SECURITY_ADMIN_USER: 'admin', GF_SERVER_ROOT_URL: publicUrl(params) }),
          secrets: ['GF_SECURITY_ADMIN_PASSWORD'],
          resources: { cpuMilli: 500, memoryMi: 512 },
          healthcheck: { path: '/api/health', intervalSec: 10, retries: 10 },
          volumes: [{ name: 'data', mountPath: '/var/lib/grafana', size: '2Gi' }],
        },
      ]),
  },
  {
    id: 'gotify',
    name: 'Gotify',
    category: 'monitoring',
    website: 'https://gotify.net',
    summary: {
      fr: 'Serveur de notifications push : une API pour envoyer, une application Android et un client web pour recevoir.',
      en: 'Push notification server: an API to send, an Android app and a web client to receive.',
    },
    firstRun: {
      fr: 'Connectez-vous avec le compte admin et le mot de passe choisi ici, puis créez une application pour obtenir son jeton.',
      en: 'Sign in with the admin account and the password chosen here, then create an application to get its token.',
    },
    askedSecrets: ['GOTIFY_DEFAULTUSER_PASS'],
    wantsHost: false,
    build: (params) =>
      appSpec(params, [
        {
          name: 'web',
          source: { type: 'image', ref: 'gotify/server:latest' },
          port: 80,
          exposed: true,
          env: { GOTIFY_DEFAULTUSER_NAME: 'admin' },
          secrets: ['GOTIFY_DEFAULTUSER_PASS'],
          resources: { cpuMilli: 250, memoryMi: 128 },
          healthcheck: { path: '/health' },
          volumes: [{ name: 'data', mountPath: '/app/data', size: '1Gi' }],
        },
      ]),
  },

  // ── Analyse ───────────────────────────────────────────────────────────────
  {
    id: 'metabase',
    name: 'Metabase',
    category: 'analytics',
    website: 'https://www.metabase.com',
    summary: {
      fr: 'Questions, graphiques et tableaux de bord sur vos bases, sans écrire de SQL — ou en en écrivant.',
      en: 'Questions, charts and dashboards over your databases, without writing SQL — or while writing it.',
    },
    firstRun: {
      fr: "Le premier démarrage prend quelques minutes (migrations). L'assistant crée ensuite le compte administrateur.",
      en: 'The first start takes a few minutes (migrations). The wizard then creates the administrator account.',
    },
    askedSecrets: [],
    wantsHost: false,
    build: (params) =>
      appSpec(params, [
        {
          name: 'web',
          source: { type: 'image', ref: 'metabase/metabase:latest' },
          port: 3000,
          exposed: true,
          env: envWhen({
            MB_DB_TYPE: 'postgres',
            MB_DB_HOST: 'postgres',
            MB_DB_PORT: '5432',
            MB_DB_DBNAME: 'metabase',
            MB_DB_USER: 'metabase',
            MB_SITE_URL: publicUrl(params),
          }),
          secrets: [{ name: 'MB_DB_PASS', from: 'POSTGRES_PASSWORD' }],
          resources: { cpuMilli: 1000, memoryMi: 2048 },
          healthcheck: { path: '/api/health', intervalSec: 15, timeoutSec: 10, retries: 40 },
          dependsOn: ['postgres'],
        },
        postgres('metabase', '5Gi'),
      ]),
  },
  {
    id: 'matomo',
    name: 'Matomo',
    category: 'analytics',
    website: 'https://matomo.org',
    summary: {
      fr: "Mesure d'audience hébergée chez vous : les données de vos visiteurs ne quittent pas votre serveur.",
      en: "Self-hosted web analytics: your visitors' data never leaves your server.",
    },
    firstRun: {
      fr: "Terminez l'assistant d'installation : la base est déjà renseignée, il reste le compte administrateur et le premier site.",
      en: 'Finish the setup wizard: the database is already filled in, the administrator account and the first site remain.',
    },
    askedSecrets: [],
    wantsHost: true,
    build: (params) =>
      appSpec(params, [
        {
          name: 'web',
          source: { type: 'image', ref: 'matomo:5-apache' },
          port: 80,
          exposed: true,
          env: {
            MATOMO_DATABASE_HOST: 'mariadb',
            MATOMO_DATABASE_ADAPTER: 'mysql',
            MATOMO_DATABASE_TABLES_PREFIX: 'matomo_',
            MATOMO_DATABASE_USERNAME: 'matomo',
            MATOMO_DATABASE_DBNAME: 'matomo',
          },
          secrets: [{ name: 'MATOMO_DATABASE_PASSWORD', from: 'MARIADB_PASSWORD' }],
          resources: { cpuMilli: 500, memoryMi: 512 },
          healthcheck: { path: '/', intervalSec: 15, retries: 10 },
          volumes: [{ name: 'html', mountPath: '/var/www/html', size: '5Gi' }],
          dependsOn: ['mariadb'],
        },
        mariadb('matomo'),
      ]),
  },

  // ── Sites et contenus ─────────────────────────────────────────────────────
  {
    id: 'wordpress',
    name: 'WordPress',
    category: 'content',
    website: 'https://wordpress.org',
    summary: {
      fr: 'Le CMS le plus répandu : un site, un blog, des extensions pour tout le reste.',
      en: 'The most widespread CMS: a site, a blog, plugins for everything else.',
    },
    firstRun: {
      fr: "Ouvrez l'application sans attendre : l'installation en cinq minutes crée le compte administrateur.",
      en: 'Open the application right away: the five-minute install creates the administrator account.',
    },
    askedSecrets: [],
    wantsHost: true,
    build: (params) =>
      appSpec(params, [
        {
          name: 'web',
          source: { type: 'image', ref: 'wordpress:6-apache' },
          port: 80,
          exposed: true,
          env: {
            WORDPRESS_DB_HOST: 'mariadb',
            WORDPRESS_DB_USER: 'wordpress',
            WORDPRESS_DB_NAME: 'wordpress',
          },
          secrets: [{ name: 'WORDPRESS_DB_PASSWORD', from: 'MARIADB_PASSWORD' }],
          resources: { cpuMilli: 500, memoryMi: 512 },
          healthcheck: { path: '/', intervalSec: 15, retries: 10 },
          volumes: [{ name: 'html', mountPath: '/var/www/html', size: '5Gi' }],
          dependsOn: ['mariadb'],
        },
        mariadb('wordpress'),
      ]),
  },
  {
    id: 'directus',
    name: 'Directus',
    category: 'content',
    website: 'https://directus.io',
    summary: {
      fr: 'Un back-office et une API REST et GraphQL posés sur une base PostgreSQL.',
      en: 'A back office and a REST and GraphQL API on top of a PostgreSQL database.',
    },
    firstRun: {
      fr: 'Connectez-vous avec votre adresse e-mail et le mot de passe administrateur choisi ici.',
      en: 'Sign in with your e-mail address and the administrator password chosen here.',
    },
    askedSecrets: ['ADMIN_PASSWORD'],
    wantsHost: false,
    build: (params) =>
      appSpec(params, [
        {
          name: 'web',
          source: { type: 'image', ref: 'directus/directus:11' },
          port: 8055,
          exposed: true,
          env: {
            DB_CLIENT: 'pg',
            DB_HOST: 'postgres',
            DB_PORT: '5432',
            DB_DATABASE: 'directus',
            DB_USER: 'directus',
            ADMIN_EMAIL: params.email,
            PUBLIC_URL: publicUrl(params) ?? '/',
          },
          secrets: [{ name: 'DB_PASSWORD', from: 'POSTGRES_PASSWORD' }, 'SECRET', 'ADMIN_PASSWORD'],
          resources: { cpuMilli: 500, memoryMi: 1024 },
          healthcheck: { path: '/server/health', intervalSec: 10, retries: 20 },
          volumes: [{ name: 'uploads', mountPath: '/directus/uploads', size: '10Gi' }],
          dependsOn: ['postgres'],
        },
        postgres('directus'),
      ]),
  },
  {
    id: 'wiki-js',
    name: 'Wiki.js',
    category: 'content',
    website: 'https://js.wiki',
    summary: {
      fr: 'Un wiki moderne en Markdown, avec recherche, historique et droits par page.',
      en: 'A modern Markdown wiki, with search, history and per-page permissions.',
    },
    firstRun: {
      fr: "Ouvrez l'application dès le déploiement terminé : l'assistant crée le compte administrateur.",
      en: 'Open the application as soon as it is deployed: the wizard creates the administrator account.',
    },
    askedSecrets: [],
    wantsHost: false,
    build: (params) =>
      appSpec(params, [
        {
          name: 'web',
          source: { type: 'image', ref: 'ghcr.io/requarks/wiki:2' },
          port: 3000,
          exposed: true,
          env: {
            DB_TYPE: 'postgres',
            DB_HOST: 'postgres',
            DB_PORT: '5432',
            DB_USER: 'wikijs',
            DB_NAME: 'wikijs',
          },
          secrets: [{ name: 'DB_PASS', from: 'POSTGRES_PASSWORD' }],
          resources: { cpuMilli: 500, memoryMi: 512 },
          healthcheck: { path: '/healthz', intervalSec: 10, retries: 20 },
          dependsOn: ['postgres'],
        },
        postgres('wikijs'),
      ]),
  },

  // ── Automatisation et IA ──────────────────────────────────────────────────
  {
    id: 'n8n',
    name: 'n8n',
    category: 'automation',
    website: 'https://n8n.io',
    summary: {
      fr: 'Des workflows qui relient vos outils — webhooks, API, bases, IA — dessinés plutôt que codés.',
      en: 'Workflows linking your tools — webhooks, APIs, databases, AI — drawn rather than coded.',
    },
    firstRun: {
      fr: "Ouvrez l'application dès le déploiement terminé : le premier écran crée le compte propriétaire.",
      en: 'Open the application as soon as it is deployed: the first screen creates the owner account.',
    },
    askedSecrets: [],
    wantsHost: true,
    build: (params) => {
      const url = publicUrl(params);
      return appSpec(params, [
        {
          name: 'web',
          source: { type: 'image', ref: 'docker.n8n.io/n8nio/n8n:latest' },
          port: 5678,
          exposed: true,
          env: envWhen({
            DB_TYPE: 'postgresdb',
            DB_POSTGRESDB_HOST: 'postgres',
            DB_POSTGRESDB_PORT: '5432',
            DB_POSTGRESDB_DATABASE: 'n8n',
            DB_POSTGRESDB_USER: 'n8n',
            N8N_HOST: params.host,
            N8N_PROTOCOL: params.host ? (params.tls ? 'https' : 'http') : null,
            WEBHOOK_URL: url ? `${url}/` : null,
            // Sans HTTPS, n8n refuse la connexion tant que le cookie exige TLS.
            N8N_SECURE_COOKIE: params.host && params.tls ? null : 'false',
          }),
          secrets: [
            { name: 'DB_POSTGRESDB_PASSWORD', from: 'POSTGRES_PASSWORD' },
            'N8N_ENCRYPTION_KEY',
          ],
          resources: { cpuMilli: 1000, memoryMi: 1024 },
          healthcheck: { path: '/healthz', intervalSec: 10, retries: 20 },
          volumes: [{ name: 'data', mountPath: '/home/node/.n8n', size: '2Gi' }],
          dependsOn: ['postgres'],
        },
        postgres('n8n'),
      ]);
    },
  },
  {
    id: 'open-webui',
    name: 'Open WebUI',
    category: 'automation',
    website: 'https://openwebui.com',
    summary: {
      fr: "Une interface de conversation pour les modèles d'IA — Ollama, OpenAI, OpenRouter — avec documents et partage.",
      en: 'A chat interface for AI models — Ollama, OpenAI, OpenRouter — with documents and sharing.',
    },
    firstRun: {
      fr: 'Le premier compte créé devient administrateur : créez-le sans attendre, puis ajoutez une clé de fournisseur dans les réglages.',
      en: 'The first account created becomes administrator: create it right away, then add a provider key in the settings.',
    },
    askedSecrets: [],
    wantsHost: false,
    build: (params) =>
      appSpec(params, [
        {
          name: 'web',
          source: { type: 'image', ref: 'ghcr.io/open-webui/open-webui:main' },
          port: 8080,
          exposed: true,
          env: envWhen({ WEBUI_URL: publicUrl(params) }),
          secrets: ['WEBUI_SECRET_KEY'],
          resources: { cpuMilli: 1000, memoryMi: 2048 },
          healthcheck: { path: '/health', intervalSec: 15, timeoutSec: 10, retries: 30 },
          volumes: [{ name: 'data', mountPath: '/app/backend/data', size: '5Gi' }],
        },
      ]),
  },

  // ── Outils de développement ───────────────────────────────────────────────
  {
    id: 'gitea',
    name: 'Gitea',
    category: 'devtools',
    website: 'https://about.gitea.com',
    summary: {
      fr: 'Forge Git légère : dépôts, tickets, revues de code, paquets et CI (Actions).',
      en: 'Lightweight Git forge: repositories, issues, code review, packages and CI (Actions).',
    },
    firstRun: {
      fr: "Terminez l'assistant d'installation : la base est déjà renseignée, créez le compte administrateur en bas de page.",
      en: 'Finish the setup wizard: the database is already filled in, create the administrator account at the bottom of the page.',
    },
    askedSecrets: [],
    wantsHost: true,
    build: (params) =>
      appSpec(params, [
        {
          name: 'web',
          source: { type: 'image', ref: 'gitea/gitea:1' },
          port: 3000,
          exposed: true,
          env: envWhen({
            DB_TYPE: 'postgres',
            DB_HOST: 'postgres:5432',
            DB_NAME: 'gitea',
            DB_USER: 'gitea',
            // Le port SSH n'est pas publié : les dépôts se clonent en HTTPS.
            DISABLE_SSH: 'true',
            DOMAIN: params.host,
            ROOT_URL: publicUrl(params) ? `${publicUrl(params)}/` : null,
          }),
          secrets: [{ name: 'DB_PASSWD', from: 'POSTGRES_PASSWORD' }],
          resources: { cpuMilli: 500, memoryMi: 512 },
          healthcheck: { path: '/', intervalSec: 10, retries: 20 },
          volumes: [{ name: 'data', mountPath: '/data', size: '20Gi' }],
          dependsOn: ['postgres'],
        },
        postgres('gitea'),
      ]),
  },
  {
    id: 'code-server',
    name: 'code-server',
    category: 'devtools',
    website: 'https://coder.com/docs/code-server',
    summary: {
      fr: 'VS Code dans le navigateur, sur la cible : un poste de développement joignable de partout.',
      en: 'VS Code in the browser, on the target: a development workstation reachable from anywhere.',
    },
    firstRun: {
      fr: 'Connectez-vous avec le mot de passe choisi ici.',
      en: 'Sign in with the password chosen here.',
    },
    askedSecrets: ['PASSWORD'],
    wantsHost: false,
    build: (params) =>
      appSpec(params, [
        {
          name: 'web',
          source: { type: 'image', ref: 'codercom/code-server:latest' },
          port: 8080,
          exposed: true,
          secrets: ['PASSWORD'],
          resources: { cpuMilli: 1000, memoryMi: 2048 },
          healthcheck: { path: '/healthz', intervalSec: 10, retries: 10 },
          volumes: [{ name: 'home', mountPath: '/home/coder', size: '20Gi' }],
        },
      ]),
  },
  {
    id: 'pgadmin',
    name: 'pgAdmin',
    category: 'devtools',
    website: 'https://www.pgadmin.org',
    summary: {
      fr: "L'outil d'administration de PostgreSQL : requêtes, schémas, sauvegardes, plans d'exécution.",
      en: 'The PostgreSQL administration tool: queries, schemas, backups, execution plans.',
    },
    firstRun: {
      fr: 'Connectez-vous avec votre adresse e-mail et le mot de passe choisi ici.',
      en: 'Sign in with your e-mail address and the password chosen here.',
    },
    askedSecrets: ['PGADMIN_DEFAULT_PASSWORD'],
    wantsHost: false,
    build: (params) =>
      appSpec(params, [
        {
          name: 'web',
          source: { type: 'image', ref: 'dpage/pgadmin4:latest' },
          // Sur le port 80, l'image se donne le droit d'écouter par `sudo` —
          // ce que `no-new-privileges` interdit : elle se rabat alors en
          // silence sur 8080. On le lui dit d'emblée, sans privilège à demander.
          port: 8080,
          exposed: true,
          env: {
            PGADMIN_LISTEN_PORT: '8080',
            PGADMIN_DEFAULT_EMAIL: params.email,
            // pgAdmin refuse au démarrage une adresse d'un domaine réservé
            // (`.local`, `.internal`, `.test`…) — et s'arrête. Une adresse
            // d'entreprise en `@corp.local` est banale : on les autorise.
            PGADMIN_CONFIG_ALLOW_SPECIAL_EMAIL_DOMAINS:
              "['local', 'localhost', 'internal', 'intranet', 'lan', 'home', 'corp', 'test', 'example']",
          },
          secrets: ['PGADMIN_DEFAULT_PASSWORD'],
          resources: { cpuMilli: 500, memoryMi: 512 },
          healthcheck: { path: '/misc/ping', intervalSec: 15, retries: 20 },
          volumes: [{ name: 'data', mountPath: '/var/lib/pgadmin', size: '1Gi' }],
        },
      ]),
  },
  {
    id: 'adminer',
    name: 'Adminer',
    category: 'devtools',
    website: 'https://www.adminer.org',
    summary: {
      fr: 'Un seul fichier PHP pour explorer MySQL, MariaDB, PostgreSQL et SQLite.',
      en: 'A single PHP file to explore MySQL, MariaDB, PostgreSQL and SQLite.',
    },
    firstRun: {
      fr: "Adminer n'a pas de compte à lui : il demande l'adresse et les identifiants de la base à ouvrir.",
      en: 'Adminer has no account of its own: it asks for the address and credentials of the database to open.',
    },
    askedSecrets: [],
    wantsHost: false,
    build: (params) =>
      appSpec(params, [
        {
          name: 'web',
          source: { type: 'image', ref: 'adminer:4' },
          port: 8080,
          exposed: true,
          resources: { cpuMilli: 250, memoryMi: 128 },
          healthcheck: { path: '/' },
        },
      ]),
  },
  {
    id: 'it-tools',
    name: 'IT Tools',
    category: 'devtools',
    website: 'https://it-tools.tech',
    summary: {
      fr: "Une centaine d'outils du quotidien : encodages, hachages, JWT, cron, UUID, conversions.",
      en: 'A hundred everyday tools: encodings, hashes, JWT, cron, UUID, conversions.',
    },
    firstRun: {
      fr: "Rien à configurer : tout s'exécute dans le navigateur, rien n'est envoyé au serveur.",
      en: 'Nothing to configure: everything runs in the browser, nothing is sent to the server.',
    },
    askedSecrets: [],
    wantsHost: false,
    build: (params) =>
      appSpec(params, [
        {
          name: 'web',
          source: { type: 'image', ref: 'corentinth/it-tools:latest' },
          port: 80,
          exposed: true,
          resources: { cpuMilli: 100, memoryMi: 64 },
          healthcheck: { path: '/' },
        },
      ]),
  },

  // ── Bureau et documents ───────────────────────────────────────────────────
  {
    id: 'nextcloud',
    name: 'Nextcloud',
    category: 'productivity',
    website: 'https://nextcloud.com',
    summary: {
      fr: 'Fichiers, agendas, contacts et partage, synchronisés sur tous vos appareils.',
      en: 'Files, calendars, contacts and sharing, synced across all your devices.',
    },
    firstRun: {
      fr: "Connectez-vous avec le compte admin et le mot de passe choisi ici. L'installation se termine seule au premier démarrage.",
      en: 'Sign in with the admin account and the password chosen here. The install completes by itself on first start.',
    },
    askedSecrets: ['NEXTCLOUD_ADMIN_PASSWORD'],
    wantsHost: true,
    build: (params) =>
      appSpec(params, [
        {
          name: 'web',
          source: { type: 'image', ref: 'nextcloud:31-apache' },
          port: 80,
          exposed: true,
          env: envWhen({
            POSTGRES_HOST: 'postgres',
            POSTGRES_DB: 'nextcloud',
            POSTGRES_USER: 'nextcloud',
            NEXTCLOUD_ADMIN_USER: 'admin',
            NEXTCLOUD_TRUSTED_DOMAINS: params.host,
            OVERWRITEPROTOCOL: params.host && params.tls ? 'https' : null,
          }),
          secrets: ['POSTGRES_PASSWORD', 'NEXTCLOUD_ADMIN_PASSWORD'],
          resources: { cpuMilli: 1000, memoryMi: 1024 },
          healthcheck: { path: '/status.php', intervalSec: 15, timeoutSec: 10, retries: 40 },
          volumes: [{ name: 'html', mountPath: '/var/www/html', size: '50Gi' }],
          dependsOn: ['postgres'],
        },
        postgres('nextcloud'),
      ]),
  },
  {
    id: 'paperless-ngx',
    name: 'Paperless-ngx',
    category: 'productivity',
    website: 'https://docs.paperless-ngx.com',
    summary: {
      fr: 'Vos papiers numérisés, lus par OCR, classés et retrouvables en une recherche.',
      en: 'Your scanned papers, read by OCR, filed and found in one search.',
    },
    firstRun: {
      fr: 'Connectez-vous avec le compte admin et le mot de passe choisi ici.',
      en: 'Sign in with the admin account and the password chosen here.',
    },
    askedSecrets: ['PAPERLESS_ADMIN_PASSWORD'],
    wantsHost: false,
    build: (params) =>
      appSpec(params, [
        {
          name: 'web',
          source: { type: 'image', ref: 'ghcr.io/paperless-ngx/paperless-ngx:latest' },
          port: 8000,
          exposed: true,
          env: envWhen({
            PAPERLESS_REDIS: 'redis://redis:6379',
            PAPERLESS_DBHOST: 'postgres',
            PAPERLESS_DBNAME: 'paperless',
            PAPERLESS_DBUSER: 'paperless',
            PAPERLESS_ADMIN_USER: 'admin',
            PAPERLESS_ADMIN_MAIL: params.email,
            PAPERLESS_URL: publicUrl(params),
          }),
          secrets: [
            { name: 'PAPERLESS_DBPASS', from: 'POSTGRES_PASSWORD' },
            'PAPERLESS_SECRET_KEY',
            'PAPERLESS_ADMIN_PASSWORD',
          ],
          resources: { cpuMilli: 1000, memoryMi: 2048 },
          healthcheck: { path: '/', intervalSec: 15, timeoutSec: 10, retries: 30 },
          volumes: [
            { name: 'data', mountPath: '/usr/src/paperless/data', size: '5Gi' },
            { name: 'media', mountPath: '/usr/src/paperless/media', size: '20Gi' },
          ],
          dependsOn: ['postgres', 'redis'],
        },
        postgres('paperless'),
        redis(),
      ]),
  },
  {
    id: 'linkding',
    name: 'linkding',
    category: 'productivity',
    website: 'https://linkding.link',
    summary: {
      fr: 'Des marque-pages rapides, étiquetés, archivés, partagés — avec une extension de navigateur.',
      en: 'Fast bookmarks, tagged, archived, shared — with a browser extension.',
    },
    firstRun: {
      fr: 'Connectez-vous avec le compte admin et le mot de passe choisi ici.',
      en: 'Sign in with the admin account and the password chosen here.',
    },
    askedSecrets: ['LD_SUPERUSER_PASSWORD'],
    wantsHost: false,
    build: (params) =>
      appSpec(params, [
        {
          name: 'web',
          source: { type: 'image', ref: 'sissbruecker/linkding:latest' },
          port: 9090,
          exposed: true,
          env: { LD_SUPERUSER_NAME: 'admin' },
          secrets: ['LD_SUPERUSER_PASSWORD'],
          resources: { cpuMilli: 250, memoryMi: 256 },
          healthcheck: { path: '/health', intervalSec: 10, retries: 10 },
          volumes: [{ name: 'data', mountPath: '/etc/linkding/data', size: '1Gi' }],
        },
      ]),
  },
  {
    id: 'memos',
    name: 'Memos',
    category: 'productivity',
    website: 'https://usememos.com',
    summary: {
      fr: 'Des notes courtes en Markdown, rangées sur une frise, publiques ou privées.',
      en: 'Short Markdown notes on a timeline, public or private.',
    },
    firstRun: {
      fr: 'Le premier compte créé devient administrateur : créez-le sans attendre.',
      en: 'The first account created becomes administrator: create it right away.',
    },
    askedSecrets: [],
    wantsHost: false,
    build: (params) =>
      appSpec(params, [
        {
          name: 'web',
          source: { type: 'image', ref: 'neosmemo/memos:stable' },
          port: 5230,
          exposed: true,
          resources: { cpuMilli: 250, memoryMi: 256 },
          healthcheck: { path: '/' },
          volumes: [{ name: 'data', mountPath: '/var/opt/memos', size: '2Gi' }],
        },
      ]),
  },
  {
    id: 'actual',
    name: 'Actual Budget',
    category: 'productivity',
    website: 'https://actualbudget.org',
    summary: {
      fr: 'Budget par enveloppes, rapide et local-first, synchronisé entre vos appareils.',
      en: 'Envelope budgeting, fast and local-first, synced across your devices.',
    },
    firstRun: {
      fr: 'Le navigateur exige HTTPS : donnez-lui un domaine avec TLS. Le premier écran fixe le mot de passe du serveur.',
      en: 'The browser requires HTTPS: give it a domain with TLS. The first screen sets the server password.',
    },
    askedSecrets: [],
    wantsHost: true,
    build: (params) =>
      appSpec(params, [
        {
          name: 'web',
          source: { type: 'image', ref: 'actualbudget/actual-server:latest-alpine' },
          port: 5006,
          exposed: true,
          resources: { cpuMilli: 250, memoryMi: 256 },
          healthcheck: { path: '/' },
          volumes: [{ name: 'data', mountPath: '/data', size: '1Gi' }],
        },
      ]),
  },
  {
    id: 'stirling-pdf',
    name: 'Stirling PDF',
    category: 'productivity',
    website: 'https://www.stirlingpdf.com',
    summary: {
      fr: 'Fusionner, découper, compresser, signer, convertir des PDF — sans les envoyer chez un tiers.',
      en: 'Merge, split, compress, sign and convert PDFs — without sending them to a third party.',
    },
    firstRun: {
      fr: "Rien à configurer : l'outil est ouvert à qui connaît son adresse.",
      en: 'Nothing to configure: the tool is open to anyone who knows its address.',
    },
    askedSecrets: [],
    wantsHost: false,
    build: (params) =>
      appSpec(params, [
        {
          name: 'web',
          source: { type: 'image', ref: 'stirlingtools/stirling-pdf:latest' },
          port: 8080,
          exposed: true,
          env: { DOCKER_ENABLE_SECURITY: 'false' },
          resources: { cpuMilli: 1000, memoryMi: 2048 },
          healthcheck: { path: '/', intervalSec: 15, timeoutSec: 10, retries: 20 },
        },
      ]),
  },
  {
    id: 'excalidraw',
    name: 'Excalidraw',
    category: 'productivity',
    website: 'https://excalidraw.com',
    summary: {
      fr: "Un tableau blanc au trait dessiné à la main, pour les schémas qu'on explique.",
      en: 'A hand-drawn style whiteboard, for the diagrams you explain.',
    },
    firstRun: {
      fr: 'Rien à configurer. Les dessins restent dans le navigateur tant que vous ne les exportez pas.',
      en: 'Nothing to configure. Drawings stay in the browser until you export them.',
    },
    askedSecrets: [],
    wantsHost: false,
    build: (params) =>
      appSpec(params, [
        {
          name: 'web',
          source: { type: 'image', ref: 'excalidraw/excalidraw:latest' },
          port: 80,
          exposed: true,
          resources: { cpuMilli: 100, memoryMi: 64 },
          healthcheck: { path: '/' },
        },
      ]),
  },
  {
    id: 'drawio',
    name: 'draw.io',
    category: 'productivity',
    website: 'https://www.drawio.com',
    summary: {
      fr: "Diagrammes d'architecture, organigrammes, BPMN, avec des milliers de formes.",
      en: 'Architecture diagrams, flowcharts, BPMN, with thousands of shapes.',
    },
    firstRun: {
      fr: 'Rien à configurer. Les diagrammes se sauvent sur votre poste ou dans vos propres stockages.',
      en: 'Nothing to configure. Diagrams are saved on your machine or in your own storage.',
    },
    askedSecrets: [],
    wantsHost: false,
    build: (params) =>
      appSpec(params, [
        {
          name: 'web',
          source: { type: 'image', ref: 'jgraph/drawio:latest' },
          port: 8080,
          exposed: true,
          resources: { cpuMilli: 500, memoryMi: 512 },
          healthcheck: { path: '/', intervalSec: 15, retries: 20 },
        },
      ]),
  },
  {
    id: 'freshrss',
    name: 'FreshRSS',
    category: 'productivity',
    website: 'https://freshrss.org',
    summary: {
      fr: 'Un agrégateur de flux RSS rapide, multi-comptes, compatible avec les applications mobiles.',
      en: 'A fast, multi-user RSS aggregator, compatible with mobile apps.',
    },
    firstRun: {
      fr: "Terminez l'assistant d'installation : choisissez SQLite, puis créez le compte administrateur.",
      en: 'Finish the setup wizard: pick SQLite, then create the administrator account.',
    },
    askedSecrets: [],
    wantsHost: false,
    build: (params) =>
      appSpec(params, [
        {
          name: 'web',
          source: { type: 'image', ref: 'freshrss/freshrss:latest' },
          port: 80,
          exposed: true,
          env: { CRON_MIN: '*/20' },
          resources: { cpuMilli: 250, memoryMi: 256 },
          healthcheck: { path: '/', intervalSec: 15, retries: 10 },
          volumes: [
            { name: 'data', mountPath: '/var/www/FreshRSS/data', size: '2Gi' },
            { name: 'extensions', mountPath: '/var/www/FreshRSS/extensions', size: '1Gi' },
          ],
        },
      ]),
  },

  // ── Médias ────────────────────────────────────────────────────────────────
  {
    id: 'jellyfin',
    name: 'Jellyfin',
    category: 'media',
    website: 'https://jellyfin.org',
    summary: {
      fr: 'Votre médiathèque — films, séries, musique — diffusée sur tous vos écrans.',
      en: 'Your media library — films, series, music — streamed to all your screens.',
    },
    firstRun: {
      fr: "L'assistant crée le compte administrateur. Déposez vos fichiers dans le volume media de la cible.",
      en: 'The wizard creates the administrator account. Put your files in the media volume on the target.',
    },
    askedSecrets: [],
    wantsHost: false,
    build: (params) =>
      appSpec(params, [
        {
          name: 'web',
          source: { type: 'image', ref: 'jellyfin/jellyfin:latest' },
          port: 8096,
          exposed: true,
          resources: { cpuMilli: 2000, memoryMi: 2048 },
          healthcheck: { path: '/health', intervalSec: 15, retries: 20 },
          volumes: [
            { name: 'config', mountPath: '/config', size: '5Gi' },
            { name: 'cache', mountPath: '/cache', size: '10Gi' },
            { name: 'media', mountPath: '/media', size: '100Gi' },
          ],
        },
      ]),
  },
  {
    id: 'navidrome',
    name: 'Navidrome',
    category: 'media',
    website: 'https://www.navidrome.org',
    summary: {
      fr: 'Votre musique en streaming, compatible Subsonic : des dizaines de clients mobiles et de bureau.',
      en: 'Your music, streamed, Subsonic-compatible: dozens of mobile and desktop clients.',
    },
    firstRun: {
      fr: 'Le premier compte créé devient administrateur. Déposez votre musique dans le volume music de la cible.',
      en: 'The first account created becomes administrator. Put your music in the music volume on the target.',
    },
    askedSecrets: [],
    wantsHost: false,
    build: (params) =>
      appSpec(params, [
        {
          name: 'web',
          source: { type: 'image', ref: 'deluan/navidrome:latest' },
          port: 4533,
          exposed: true,
          resources: { cpuMilli: 500, memoryMi: 256 },
          healthcheck: { path: '/ping' },
          volumes: [
            { name: 'data', mountPath: '/data', size: '2Gi' },
            { name: 'music', mountPath: '/music', size: '50Gi' },
          ],
        },
      ]),
  },

  // ── Sécurité ──────────────────────────────────────────────────────────────
  {
    id: 'vaultwarden',
    name: 'Vaultwarden',
    category: 'security',
    website: 'https://github.com/dani-garcia/vaultwarden',
    summary: {
      fr: 'Un serveur compatible Bitwarden, léger : les applications et extensions officielles s’y connectent.',
      en: 'A lightweight Bitwarden-compatible server: the official apps and extensions connect to it.',
    },
    firstRun: {
      fr: 'Le coffre web exige HTTPS : donnez-lui un domaine avec TLS. Le jeton choisi ici ouvre la page /admin ; fermez les inscriptions une fois vos comptes créés.',
      en: 'The web vault requires HTTPS: give it a domain with TLS. The token chosen here opens the /admin page; close sign-ups once your accounts exist.',
    },
    askedSecrets: ['ADMIN_TOKEN'],
    wantsHost: true,
    build: (params) =>
      appSpec(params, [
        {
          name: 'web',
          source: { type: 'image', ref: 'vaultwarden/server:latest' },
          port: 80,
          exposed: true,
          env: envWhen({ DOMAIN: publicUrl(params), SIGNUPS_ALLOWED: 'true' }),
          secrets: ['ADMIN_TOKEN'],
          resources: { cpuMilli: 250, memoryMi: 256 },
          healthcheck: { path: '/alive' },
          volumes: [{ name: 'data', mountPath: '/data', size: '2Gi' }],
        },
      ]),
  },

  // ── Démonstration ─────────────────────────────────────────────────────────
  {
    id: 'hello',
    name: 'Hello World',
    category: 'demo',
    website: 'https://github.com/nginxinc/NGINX-Demos',
    summary: {
      fr: "Une page qui affiche le nom du conteneur et l'adresse qui l'a servie : de quoi vérifier une cible et son proxy.",
      en: 'A page showing the container name and the address that served it: enough to check a target and its proxy.',
    },
    firstRun: {
      fr: 'Rien à configurer : ouvrez son adresse, la page répond.',
      en: 'Nothing to configure: open its address, the page answers.',
    },
    askedSecrets: [],
    wantsHost: false,
    build: (params) =>
      appSpec(params, [
        {
          name: 'web',
          source: { type: 'image', ref: 'nginxdemos/hello:latest' },
          port: 80,
          exposed: true,
          resources: { cpuMilli: 100, memoryMi: 64 },
          healthcheck: { path: '/' },
        },
      ]),
  },
];
