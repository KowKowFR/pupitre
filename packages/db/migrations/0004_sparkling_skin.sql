ALTER TABLE "targets" ADD COLUMN "port_range_start" integer DEFAULT 30000 NOT NULL;--> statement-breakpoint
ALTER TABLE "targets" ADD COLUMN "port_range_end" integer DEFAULT 32767 NOT NULL;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "auto_rollback" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "targets" ADD CONSTRAINT "targets_port_range_check" CHECK ("targets"."port_range_start" <= "targets"."port_range_end");