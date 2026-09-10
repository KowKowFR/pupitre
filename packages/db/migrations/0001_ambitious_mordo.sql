CREATE TYPE "public"."sudo_method" AS ENUM('nopasswd', 'password');--> statement-breakpoint
ALTER TABLE "targets" ALTER COLUMN "status" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "targets" ALTER COLUMN "status" SET DEFAULT 'unknown'::text;--> statement-breakpoint
DROP TYPE "public"."target_status";--> statement-breakpoint
CREATE TYPE "public"."target_status" AS ENUM('unknown', 'ok', 'degraded', 'unreachable');--> statement-breakpoint
ALTER TABLE "targets" ALTER COLUMN "status" SET DEFAULT 'unknown'::"public"."target_status";--> statement-breakpoint
ALTER TABLE "targets" ALTER COLUMN "status" SET DATA TYPE "public"."target_status" USING "status"::"public"."target_status";--> statement-breakpoint
ALTER TABLE "targets" ALTER COLUMN "runtimes_available" SET DEFAULT '{"docker":{"available":false,"version":null,"composeVersion":null},"k3s":{"available":false,"version":null,"nodes":null,"readyNodes":null,"clusterReady":false}}'::jsonb;--> statement-breakpoint
ALTER TABLE "targets" ADD COLUMN "sudo_method" "sudo_method" DEFAULT 'nopasswd' NOT NULL;--> statement-breakpoint
ALTER TABLE "targets" ADD COLUMN "labels" jsonb DEFAULT '{}'::jsonb NOT NULL;