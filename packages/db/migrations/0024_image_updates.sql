CREATE TYPE "public"."image_update_status" AS ENUM('current', 'outdated', 'unknown', 'pinned');--> statement-breakpoint
CREATE TABLE "image_updates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"target_id" uuid NOT NULL,
	"deployment_id" uuid,
	"service" text NOT NULL,
	"image" text NOT NULL,
	"status" "image_update_status" NOT NULL,
	"running_digest" text,
	"latest_digest" text,
	"newer_tag" text,
	"next_major_tag" text,
	"error" text,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"notified_key" text
);
--> statement-breakpoint
ALTER TABLE "image_updates" ADD CONSTRAINT "image_updates_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "image_updates" ADD CONSTRAINT "image_updates_target_id_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."targets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "image_updates" ADD CONSTRAINT "image_updates_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "image_updates_app_target_service_idx" ON "image_updates" USING btree ("application_id","target_id","service");--> statement-breakpoint
CREATE INDEX "image_updates_application_idx" ON "image_updates" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "image_updates_status_idx" ON "image_updates" USING btree ("status");