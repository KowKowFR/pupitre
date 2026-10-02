CREATE TYPE "public"."source_archive_status" AS ENUM('receiving', 'pending', 'ready', 'rejected');--> statement-breakpoint
CREATE TABLE "source_archive_chunks" (
	"archive_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"seq" integer NOT NULL,
	"data" "bytea" NOT NULL,
	CONSTRAINT "source_archive_chunks_archive_id_kind_seq_pk" PRIMARY KEY("archive_id","kind","seq")
);
--> statement-breakpoint
CREATE TABLE "source_archives" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"name" text NOT NULL,
	"format" text NOT NULL,
	"status" "source_archive_status" DEFAULT 'receiving' NOT NULL,
	"uploaded_bytes" bigint DEFAULT 0 NOT NULL,
	"sha256" text,
	"archive_bytes" bigint,
	"report" jsonb,
	"rejection" text,
	"rejection_detail" text,
	"uploaded_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"inspected_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "app_settings" ALTER COLUMN "value" SET DEFAULT '{"instanceName":"Pupitre","instanceTagline":"Plan de contrôle de déploiement","timezone":"Europe/Paris","locale":"fr-FR","dateStyle":"short","timeStyle":"medium","ai":{"provider":"openrouter","model":"anthropic/claude-sonnet-4.5","baseUrl":"","enabled":true,"temperature":0.2,"maxTokens":8192},"security":{"scanningEnabled":true,"disabledScanners":[],"failOn":"NONE"},"sso":{"enabled":false,"label":"Keycloak","issuer":"","clientId":"","scopes":"openid profile email","autoCreate":true,"linkByEmail":true,"groupsClaim":"groups","roleMappings":[],"defaultRole":"no-access","syncRoles":true},"accounts":{"twoFactorPolicy":"off","sessionIdleHours":168,"sessionMaxHours":null},"onboarding":{"status":"pending","currentStep":"welcome","completed":[],"skipped":[],"offeredAt":null,"finishedAt":null,"dismissedAt":null,"runs":0}}'::jsonb;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "source_archive_id" uuid;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "source_archive_name" text;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "source_archive_sha256" text;--> statement-breakpoint
ALTER TABLE "source_archive_chunks" ADD CONSTRAINT "source_archive_chunks_archive_id_source_archives_id_fk" FOREIGN KEY ("archive_id") REFERENCES "public"."source_archives"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_archives" ADD CONSTRAINT "source_archives_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_archives" ADD CONSTRAINT "source_archives_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "source_archives_application_idx" ON "source_archives" USING btree ("application_id","created_at");--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_source_archive_id_source_archives_id_fk" FOREIGN KEY ("source_archive_id") REFERENCES "public"."source_archives"("id") ON DELETE set null ON UPDATE no action;