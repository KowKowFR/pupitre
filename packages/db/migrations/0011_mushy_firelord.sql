CREATE TABLE "monitor_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"monitor_id" uuid NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"outcome" "health_status" NOT NULL,
	"latency_ms" integer,
	"detail" text,
	"metrics" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "monitor_incidents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"monitor_id" uuid NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"cause" "health_status" NOT NULL,
	"detail" text,
	"metrics" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"failure_count" integer DEFAULT 1 NOT NULL,
	"alert_sent_at" timestamp with time zone,
	"alert_error" text,
	"resolve_alert_sent_at" timestamp with time zone,
	"resolve_alert_error" text
);
--> statement-breakpoint
CREATE TABLE "monitors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"type" text DEFAULT 'http' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"interval_seconds" integer DEFAULT 60 NOT NULL,
	"failure_threshold" integer DEFAULT 3 NOT NULL,
	"recovery_threshold" integer DEFAULT 2 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"paused_reason" text,
	"application_id" uuid,
	"webhook_url_encrypted" text,
	"status" "health_status" DEFAULT 'unknown' NOT NULL,
	"last_outcome" "health_status",
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"consecutive_successes" integer DEFAULT 0 NOT NULL,
	"last_checked_at" timestamp with time zone,
	"last_latency_ms" integer,
	"last_detail" text,
	"last_metrics" jsonb,
	"next_check_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "monitors_interval_check" CHECK ("monitors"."interval_seconds" >= 30 and "monitors"."interval_seconds" <= 2592000),
	CONSTRAINT "monitors_threshold_check" CHECK ("monitors"."failure_threshold" between 1 and 10 and "monitors"."recovery_threshold" between 1 and 10)
);
--> statement-breakpoint
ALTER TABLE "monitor_checks" ADD CONSTRAINT "monitor_checks_monitor_id_monitors_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."monitors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitor_incidents" ADD CONSTRAINT "monitor_incidents_monitor_id_monitors_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."monitors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitors" ADD CONSTRAINT "monitors_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitors" ADD CONSTRAINT "monitors_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "monitor_checks_monitor_time_idx" ON "monitor_checks" USING btree ("monitor_id","checked_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "monitor_checks_checked_at_idx" ON "monitor_checks" USING btree ("checked_at");--> statement-breakpoint
CREATE UNIQUE INDEX "monitor_incidents_open_idx" ON "monitor_incidents" USING btree ("monitor_id") WHERE "monitor_incidents"."resolved_at" is null;--> statement-breakpoint
CREATE INDEX "monitor_incidents_monitor_started_idx" ON "monitor_incidents" USING btree ("monitor_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "monitors_due_idx" ON "monitors" USING btree ("next_check_at") WHERE "monitors"."enabled";--> statement-breakpoint
CREATE INDEX "monitors_application_id_idx" ON "monitors" USING btree ("application_id");