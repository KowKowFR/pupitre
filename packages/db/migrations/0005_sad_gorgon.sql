CREATE TYPE "public"."health_status" AS ENUM('unknown', 'healthy', 'unhealthy', 'unreachable');--> statement-breakpoint
CREATE TABLE "scheduled_job_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scheduled_job_id" uuid NOT NULL,
	"status" "step_status" DEFAULT 'running' NOT NULL,
	"manual" boolean DEFAULT false NOT NULL,
	"summary" jsonb,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "generation_prompt" text;--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "generation_model" text;--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "generated_app_spec" jsonb;--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "generated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "health_status" "health_status" DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "last_health_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "scheduled_job_runs" ADD CONSTRAINT "scheduled_job_runs_scheduled_job_id_scheduled_jobs_id_fk" FOREIGN KEY ("scheduled_job_id") REFERENCES "public"."scheduled_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "scheduled_job_runs_job_id_idx" ON "scheduled_job_runs" USING btree ("scheduled_job_id");--> statement-breakpoint
CREATE INDEX "scheduled_job_runs_started_at_idx" ON "scheduled_job_runs" USING btree ("started_at");