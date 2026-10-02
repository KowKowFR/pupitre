ALTER TABLE "targets" ADD COLUMN "unreachable_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "routes" ADD COLUMN "certificate_alert" text;