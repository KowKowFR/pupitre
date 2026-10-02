CREATE TYPE "public"."source_deploy_to" AS ENUM('targets', 'running', 'none');--> statement-breakpoint
ALTER TABLE "application_sources" ADD COLUMN "deploy_to" "source_deploy_to" DEFAULT 'targets' NOT NULL;--> statement-breakpoint
ALTER TABLE "application_sources" ADD COLUMN "synced_sha" text;--> statement-breakpoint
ALTER TABLE "application_sources" ADD COLUMN "synced_at" timestamp with time zone;
--> statement-breakpoint
-- Les liaisons existantes : leur application porte l'AppSpec du dernier commit
-- déployé depuis elles — c'est lui qu'un déploiement à la main reconstruira.
UPDATE "application_sources" AS s
SET "synced_sha" = d."source_sha", "synced_at" = d."created_at"
FROM (
  SELECT DISTINCT ON ("source_id") "source_id", "source_sha", "created_at"
  FROM "deployments"
  WHERE "source_id" IS NOT NULL AND "source_sha" IS NOT NULL
  ORDER BY "source_id", "created_at" DESC
) AS d
WHERE d."source_id" = s."id";
