CREATE TABLE "target_metric_breaches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_id" uuid NOT NULL,
	"metric" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"limit_percent" real NOT NULL,
	"opened_value" real NOT NULL,
	"peak_value" real NOT NULL,
	"last_value" real NOT NULL,
	"samples" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "target_metric_samples" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_id" uuid NOT NULL,
	"sampled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source" text DEFAULT 'sweep' NOT NULL,
	"reachable" boolean NOT NULL,
	"latency_ms" integer,
	"error" text,
	"load_one" real,
	"load_five" real,
	"load_fifteen" real,
	"cores" integer,
	"load_percent" real,
	"memory_total_kb" bigint,
	"memory_used_kb" bigint,
	"memory_percent" real,
	"disk_path" text,
	"disk_size_kb" bigint,
	"disk_used_kb" bigint,
	"disk_percent" real,
	"uptime_seconds" bigint
);
--> statement-breakpoint
CREATE TABLE "target_metric_thresholds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_id" uuid,
	"metric" text NOT NULL,
	"limit_percent" real NOT NULL,
	"breach_samples" integer DEFAULT 1 NOT NULL,
	"clear_samples" integer DEFAULT 2 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "target_metric_thresholds_limit_check" CHECK ("target_metric_thresholds"."limit_percent" > 0 and "target_metric_thresholds"."limit_percent" <= 1000),
	CONSTRAINT "target_metric_thresholds_samples_check" CHECK ("target_metric_thresholds"."breach_samples" between 1 and 10 and "target_metric_thresholds"."clear_samples" between 1 and 10)
);
--> statement-breakpoint
ALTER TABLE "app_settings" ALTER COLUMN "value" SET DEFAULT '{"instanceName":"Pupitre","instanceTagline":"Plan de contrôle de déploiement","timezone":"Europe/Paris","locale":"fr-FR","dateStyle":"short","timeStyle":"medium","ai":{"provider":"openrouter","model":"anthropic/claude-sonnet-4.5","baseUrl":"","enabled":true,"temperature":0.2,"maxTokens":8192},"security":{"scanningEnabled":true,"disabledScanners":[],"failOn":"NONE"},"onboarding":{"status":"pending","currentStep":"welcome","completed":[],"skipped":[],"offeredAt":null,"finishedAt":null,"dismissedAt":null,"runs":0}}'::jsonb;--> statement-breakpoint
ALTER TABLE "target_metric_breaches" ADD CONSTRAINT "target_metric_breaches_target_id_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."targets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "target_metric_samples" ADD CONSTRAINT "target_metric_samples_target_id_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."targets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "target_metric_thresholds" ADD CONSTRAINT "target_metric_thresholds_target_id_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."targets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "target_metric_thresholds" ADD CONSTRAINT "target_metric_thresholds_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "target_metric_breaches_open_idx" ON "target_metric_breaches" USING btree ("target_id","metric") WHERE "target_metric_breaches"."resolved_at" is null;--> statement-breakpoint
CREATE INDEX "target_metric_breaches_target_started_idx" ON "target_metric_breaches" USING btree ("target_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "target_metric_samples_target_time_idx" ON "target_metric_samples" USING btree ("target_id","sampled_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "target_metric_samples_sampled_at_idx" ON "target_metric_samples" USING btree ("sampled_at");--> statement-breakpoint
CREATE UNIQUE INDEX "target_metric_thresholds_target_idx" ON "target_metric_thresholds" USING btree ("target_id","metric") WHERE "target_metric_thresholds"."target_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "target_metric_thresholds_global_idx" ON "target_metric_thresholds" USING btree ("metric") WHERE "target_metric_thresholds"."target_id" is null;