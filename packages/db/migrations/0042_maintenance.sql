CREATE TABLE "maintenance_held_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"window_id" uuid NOT NULL,
	"event" text NOT NULL,
	"family" text NOT NULL,
	"opens" boolean NOT NULL,
	"label" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"data" jsonb NOT NULL,
	"held_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "maintenance_window_monitors" (
	"window_id" uuid NOT NULL,
	"monitor_id" uuid NOT NULL,
	CONSTRAINT "maintenance_window_monitors_window_id_monitor_id_pk" PRIMARY KEY("window_id","monitor_id")
);
--> statement-breakpoint
CREATE TABLE "maintenance_window_targets" (
	"window_id" uuid NOT NULL,
	"target_id" uuid NOT NULL,
	CONSTRAINT "maintenance_window_targets_window_id_target_id_pk" PRIMARY KEY("window_id","target_id")
);
--> statement-breakpoint
CREATE TABLE "maintenance_windows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"note" text,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "maintenance_windows_order" CHECK ("maintenance_windows"."ends_at" > "maintenance_windows"."starts_at")
);
--> statement-breakpoint
ALTER TABLE "maintenance_held_alerts" ADD CONSTRAINT "maintenance_held_alerts_window_id_maintenance_windows_id_fk" FOREIGN KEY ("window_id") REFERENCES "public"."maintenance_windows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_window_monitors" ADD CONSTRAINT "maintenance_window_monitors_window_id_maintenance_windows_id_fk" FOREIGN KEY ("window_id") REFERENCES "public"."maintenance_windows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_window_monitors" ADD CONSTRAINT "maintenance_window_monitors_monitor_id_monitors_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."monitors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_window_targets" ADD CONSTRAINT "maintenance_window_targets_window_id_maintenance_windows_id_fk" FOREIGN KEY ("window_id") REFERENCES "public"."maintenance_windows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_window_targets" ADD CONSTRAINT "maintenance_window_targets_target_id_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."targets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_windows" ADD CONSTRAINT "maintenance_windows_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "maintenance_held_alerts_window_idx" ON "maintenance_held_alerts" USING btree ("window_id","held_at");--> statement-breakpoint
CREATE INDEX "maintenance_window_monitors_monitor_idx" ON "maintenance_window_monitors" USING btree ("monitor_id");--> statement-breakpoint
CREATE INDEX "maintenance_window_targets_target_idx" ON "maintenance_window_targets" USING btree ("target_id");--> statement-breakpoint
CREATE INDEX "maintenance_windows_ends_idx" ON "maintenance_windows" USING btree ("ends_at");