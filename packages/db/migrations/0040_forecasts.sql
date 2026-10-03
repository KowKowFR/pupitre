CREATE TABLE "forecasts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"subject_name" text NOT NULL,
	"severity" text NOT NULL,
	"eta_at" timestamp with time zone,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "forecasts_open_idx" ON "forecasts" USING btree ("kind","subject_type","subject_id") WHERE "forecasts"."resolved_at" is null;--> statement-breakpoint
CREATE INDEX "forecasts_subject_idx" ON "forecasts" USING btree ("subject_type","subject_id");