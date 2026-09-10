CREATE TABLE "app_settings" (
	"id" smallint PRIMARY KEY NOT NULL,
	"value" jsonb DEFAULT '{"instanceName":"Control plane","instanceTagline":"Bootstrap TP v2","timezone":"Europe/Paris","locale":"fr-FR","dateStyle":"short","timeStyle":"medium","ai":{"provider":"openrouter","model":"anthropic/claude-sonnet-4.5","enabled":true,"temperature":0.2,"maxTokens":8192}}'::jsonb NOT NULL,
	"ai_api_key_encrypted" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text,
	CONSTRAINT "app_settings_singleton_check" CHECK ("app_settings"."id" = 1)
);
--> statement-breakpoint
ALTER TABLE "app_settings" ADD CONSTRAINT "app_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;