CREATE TYPE "public"."proxy_placement" AS ENUM('target', 'remote');--> statement-breakpoint
CREATE TYPE "public"."proxy_status" AS ENUM('unknown', 'installing', 'ok', 'failed');--> statement-breakpoint
CREATE TYPE "public"."route_status" AS ENUM('pending', 'active', 'failed');--> statement-breakpoint
CREATE TABLE "proxies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "proxy" NOT NULL,
	"name" text NOT NULL,
	"placement" "proxy_placement" DEFAULT 'target' NOT NULL,
	"host_target_id" uuid,
	"config" jsonb NOT NULL,
	"encrypted_secrets" text,
	"managed" boolean DEFAULT false NOT NULL,
	"status" "proxy_status" DEFAULT 'unknown' NOT NULL,
	"last_checked_at" timestamp with time zone,
	"last_check_error" text,
	"last_check" jsonb,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "proxies_target_has_host" CHECK ("proxies"."placement" <> 'target' or "proxies"."host_target_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "routes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"target_id" uuid NOT NULL,
	"hostname" text NOT NULL,
	"tls" boolean DEFAULT true NOT NULL,
	"redirect_https" boolean DEFAULT true NOT NULL,
	"status" "route_status" DEFAULT 'pending' NOT NULL,
	"last_error" text,
	"last_checked_at" timestamp with time zone,
	"certificate" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "routes_hostname_unique" UNIQUE("hostname")
);
--> statement-breakpoint
ALTER TABLE "proxies" ADD CONSTRAINT "proxies_host_target_id_targets_id_fk" FOREIGN KEY ("host_target_id") REFERENCES "public"."targets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proxies" ADD CONSTRAINT "proxies_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routes" ADD CONSTRAINT "routes_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routes" ADD CONSTRAINT "routes_target_id_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."targets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "proxies_host_target_unique" ON "proxies" USING btree ("host_target_id") WHERE "proxies"."host_target_id" is not null;--> statement-breakpoint
CREATE INDEX "routes_couple_idx" ON "routes" USING btree ("application_id","target_id");--> statement-breakpoint
-- ─── Reprise : ce qui marchait avant doit marcher après ──────────────────────
-- Avant cette migration, un domaine d'AppSpec (`ingress.host`) était routé sans
-- connexion déclarée : par l'Ingress que le driver K3s posait lui-même, et, sous
-- Docker, par un fichier déposé dans `{racine}/proxy/dynamic` pour un Traefik
-- supposé présent. On déclare ces deux proxies tels qu'ils étaient, et les
-- domaines en service deviennent des routes. Rien n'est vérifié ici : la
-- prochaine sonde dira ce qui répond.

-- Le Traefik livré avec K3s, sans résolveur : l'Ingress d'avant n'en demandait pas.
INSERT INTO "proxies" ("kind", "name", "placement", "host_target_id", "config", "managed")
SELECT 'traefik', 'Traefik (K3s)', 'target', t."id",
  '{"mode":"kubernetes","ingressClass":"traefik","namespace":"kube-system","entryPoints":{"http":"web","https":"websecure"},"certResolver":null,"acme":null}'::jsonb,
  false
FROM "targets" t
WHERE t."runtimes_available"->'k3s'->>'available' = 'true';--> statement-breakpoint

-- Le Traefik que le fichier de routes supposait, là où un domaine était en service.
INSERT INTO "proxies" ("kind", "name", "placement", "host_target_id", "config", "managed")
SELECT 'traefik', 'Traefik', 'target', t."id",
  '{"mode":"file","directory":null,"upstreamHost":"127.0.0.1","container":null,"image":null,"entryPoints":{"http":"web","https":"websecure"},"certResolver":"default","acme":null}'::jsonb,
  false
FROM "targets" t
WHERE NOT EXISTS (SELECT 1 FROM "proxies" p WHERE p."host_target_id" = t."id")
  AND EXISTS (
    SELECT 1 FROM "deployments" d
    WHERE d."target_id" = t."id" AND d."status" = 'success'
      AND d."app_spec"->'ingress'->>'host' IS NOT NULL
  );--> statement-breakpoint

-- Les domaines en service : le dernier déploiement de chaque couple, s'il a réussi.
INSERT INTO "routes" ("application_id", "target_id", "hostname", "tls", "redirect_https")
SELECT live."application_id", live."target_id", lower(live."app_spec"->'ingress'->>'host'),
  coalesce((live."app_spec"->'ingress'->>'tls')::boolean, false), false
FROM (
  SELECT DISTINCT ON (d."application_id", d."target_id") d.*
  FROM "deployments" d
  WHERE d."status" IN ('success', 'destroyed')
  ORDER BY d."application_id", d."target_id", d."version" DESC, d."created_at" DESC
) live
WHERE live."status" = 'success' AND live."app_spec"->'ingress'->>'host' IS NOT NULL
ON CONFLICT ("hostname") DO NOTHING;
