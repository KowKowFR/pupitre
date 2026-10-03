CREATE TYPE "public"."status_update_phase" AS ENUM('investigating', 'identified', 'monitoring', 'resolved', 'scheduled', 'in_progress', 'completed');--> statement-breakpoint
CREATE TABLE "status_updates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"monitor_incident_id" uuid,
	"maintenance_window_id" uuid,
	"phase" "status_update_phase" NOT NULL,
	"message" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "status_updates_one_subject" CHECK (("status_updates"."monitor_incident_id" is null) <> ("status_updates"."maintenance_window_id" is null))
);
--> statement-breakpoint
ALTER TABLE "status_updates" ADD CONSTRAINT "status_updates_monitor_incident_id_monitor_incidents_id_fk" FOREIGN KEY ("monitor_incident_id") REFERENCES "public"."monitor_incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "status_updates" ADD CONSTRAINT "status_updates_maintenance_window_id_maintenance_windows_id_fk" FOREIGN KEY ("maintenance_window_id") REFERENCES "public"."maintenance_windows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "status_updates" ADD CONSTRAINT "status_updates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "status_updates_incident_idx" ON "status_updates" USING btree ("monitor_incident_id","created_at");--> statement-breakpoint
CREATE INDEX "status_updates_window_idx" ON "status_updates" USING btree ("maintenance_window_id","created_at");