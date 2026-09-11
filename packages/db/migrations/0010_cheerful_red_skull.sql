CREATE TYPE "public"."secret_origin" AS ENUM('generated', 'provided');--> statement-breakpoint
CREATE TABLE "application_secrets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"name" text NOT NULL,
	"encrypted_value" text NOT NULL,
	"origin" "secret_origin" DEFAULT 'generated' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app_settings" ALTER COLUMN "value" SET DEFAULT '{"instanceName":"Control plane","instanceTagline":"Bootstrap TP v2","timezone":"Europe/Paris","locale":"fr-FR","dateStyle":"short","timeStyle":"medium","ai":{"provider":"openrouter","model":"anthropic/claude-sonnet-4.5","baseUrl":"","enabled":true,"temperature":0.2,"maxTokens":8192},"security":{"scanningEnabled":true,"disabledScanners":[],"failOn":"CRITICAL"},"onboarding":{"status":"pending","currentStep":"welcome","completed":[],"skipped":[],"offeredAt":null,"finishedAt":null,"dismissedAt":null,"runs":0}}'::jsonb;--> statement-breakpoint
ALTER TABLE "application_secrets" ADD CONSTRAINT "application_secrets_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "application_secrets_app_name_idx" ON "application_secrets" USING btree ("application_id","name");--> statement-breakpoint
CREATE INDEX "application_secrets_application_id_idx" ON "application_secrets" USING btree ("application_id");