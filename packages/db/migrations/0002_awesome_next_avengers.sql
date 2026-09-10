ALTER TABLE "deployment_steps" ADD COLUMN "log" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "app_spec" jsonb;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "published_port" integer;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "failed_step" text;