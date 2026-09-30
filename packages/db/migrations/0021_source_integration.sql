CREATE TYPE "public"."source_mode" AS ENUM('auto', 'auto_unless_infra', 'manual');--> statement-breakpoint
CREATE TYPE "public"."source_proposal_status" AS ENUM('pending', 'approved', 'dismissed', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."source_provider" AS ENUM('github');--> statement-breakpoint
CREATE TABLE "application_source_targets" (
	"source_id" uuid NOT NULL,
	"target_id" uuid NOT NULL,
	"runtime" "runtime" NOT NULL,
	CONSTRAINT "application_source_targets_source_id_target_id_pk" PRIMARY KEY("source_id","target_id")
);
--> statement-breakpoint
CREATE TABLE "application_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"installation_id" bigint NOT NULL,
	"repository" text NOT NULL,
	"branch" text NOT NULL,
	"spec_path" text DEFAULT 'pupitre.json' NOT NULL,
	"watch_paths" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"mode" "source_mode" DEFAULT 'auto_unless_infra' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_seen_sha" text,
	"last_etag" text,
	"last_checked_at" timestamp with time zone,
	"last_change_at" timestamp with time zone,
	"last_error" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" "source_provider" NOT NULL,
	"app_id" integer NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"html_url" text NOT NULL,
	"owner" text NOT NULL,
	"api_url" text,
	"private_key_encrypted" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"sha" text NOT NULL,
	"commit_message" text,
	"commit_author" text,
	"commit_url" text,
	"app_spec" jsonb NOT NULL,
	"reason" text NOT NULL,
	"changes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "source_proposal_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "source_id" uuid;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "source_repository" text;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "source_ref" text;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "source_sha" text;--> statement-breakpoint
ALTER TABLE "application_source_targets" ADD CONSTRAINT "application_source_targets_source_id_application_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."application_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_source_targets" ADD CONSTRAINT "application_source_targets_target_id_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."targets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_sources" ADD CONSTRAINT "application_sources_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_sources" ADD CONSTRAINT "application_sources_connection_id_source_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."source_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_sources" ADD CONSTRAINT "application_sources_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_connections" ADD CONSTRAINT "source_connections_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_proposals" ADD CONSTRAINT "source_proposals_source_id_application_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."application_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_proposals" ADD CONSTRAINT "source_proposals_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "application_sources_application_idx" ON "application_sources" USING btree ("application_id");--> statement-breakpoint
CREATE UNIQUE INDEX "application_sources_branch_idx" ON "application_sources" USING btree ("application_id","repository","branch");--> statement-breakpoint
CREATE UNIQUE INDEX "source_connections_provider_idx" ON "source_connections" USING btree ("provider");--> statement-breakpoint
CREATE UNIQUE INDEX "source_proposals_commit_idx" ON "source_proposals" USING btree ("source_id","sha");--> statement-breakpoint
CREATE INDEX "source_proposals_status_idx" ON "source_proposals" USING btree ("status");--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_source_id_application_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."application_sources"("id") ON DELETE set null ON UPDATE no action;