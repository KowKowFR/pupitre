ALTER TYPE "public"."source_provider" ADD VALUE 'gitea';--> statement-breakpoint
ALTER TABLE "application_sources" ALTER COLUMN "installation_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "source_connections" ALTER COLUMN "app_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "source_connections" ALTER COLUMN "slug" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "source_connections" ALTER COLUMN "private_key_encrypted" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "source_connections" ADD COLUMN "token_encrypted" text;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "source_url" text;