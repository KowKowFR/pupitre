CREATE TYPE "public"."backup_destination_kind" AS ENUM('s3', 'sftp', 'local');--> statement-breakpoint
CREATE TYPE "public"."backup_kind" AS ENUM('application', 'panel');--> statement-breakpoint
CREATE TYPE "public"."backup_mode" AS ENUM('hot', 'stop');--> statement-breakpoint
CREATE TYPE "public"."backup_status" AS ENUM('running', 'success', 'failed');--> statement-breakpoint
CREATE TYPE "public"."backup_trigger" AS ENUM('schedule', 'manual', 'pre_deploy', 'pre_restore');--> statement-breakpoint
ALTER TYPE "public"."scheduled_job_type" ADD VALUE 'backup';--> statement-breakpoint
ALTER TYPE "public"."scheduled_job_type" ADD VALUE 'panel_backup';--> statement-breakpoint
CREATE TABLE "backup_destinations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "backup_destination_kind" NOT NULL,
	"name" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"encrypted_secrets" text,
	"secret_fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_checked_at" timestamp with time zone,
	"last_check_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "backup_policies" (
	"application_id" uuid PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"mode" "backup_mode" DEFAULT 'hot' NOT NULL,
	"before_deploy" boolean DEFAULT false NOT NULL,
	"retention" jsonb NOT NULL,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "backups" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" "backup_kind" NOT NULL,
	"application_id" uuid,
	"application_slug" text,
	"target_id" uuid,
	"deployment_id" uuid,
	"destination_id" uuid,
	"trigger" "backup_trigger" NOT NULL,
	"mode" "backup_mode",
	"status" "backup_status" DEFAULT 'running' NOT NULL,
	"location" text NOT NULL,
	"manifest" jsonb,
	"bytes" bigint DEFAULT 0 NOT NULL,
	"error" text,
	"requested_by" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "backup_policies" ADD CONSTRAINT "backup_policies_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_policies" ADD CONSTRAINT "backup_policies_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backups" ADD CONSTRAINT "backups_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backups" ADD CONSTRAINT "backups_target_id_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."targets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backups" ADD CONSTRAINT "backups_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backups" ADD CONSTRAINT "backups_destination_id_backup_destinations_id_fk" FOREIGN KEY ("destination_id") REFERENCES "public"."backup_destinations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backups" ADD CONSTRAINT "backups_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "backups_application_started_idx" ON "backups" USING btree ("application_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "backups_kind_started_idx" ON "backups" USING btree ("kind","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "backups_status_idx" ON "backups" USING btree ("status");