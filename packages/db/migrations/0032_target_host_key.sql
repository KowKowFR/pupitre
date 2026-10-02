ALTER TABLE "targets" ADD COLUMN "host_key_fingerprint" text;--> statement-breakpoint
ALTER TABLE "targets" ADD COLUMN "host_key_recorded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "targets" ADD COLUMN "host_key_pending" text;--> statement-breakpoint
ALTER TABLE "targets" ADD COLUMN "host_key_pending_at" timestamp with time zone;