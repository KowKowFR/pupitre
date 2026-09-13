CREATE TABLE "monitor_captures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"monitor_id" uuid NOT NULL,
	"incident_id" uuid,
	"kind" text NOT NULL,
	"taken_at" timestamp with time zone DEFAULT now() NOT NULL,
	"url" text NOT NULL,
	"final_url" text,
	"http_status" integer,
	"page_title" text,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"format" text DEFAULT 'jpeg' NOT NULL,
	"bytes" integer NOT NULL,
	"truncated" boolean DEFAULT false NOT NULL,
	"elapsed_ms" integer,
	"image" "bytea",
	"purged_at" timestamp with time zone,
	CONSTRAINT "monitor_captures_kind_check" CHECK ("monitor_captures"."kind" in ('reference', 'incident_open', 'incident_resolved')),
	CONSTRAINT "monitor_captures_incident_check" CHECK (("monitor_captures"."kind" = 'reference') or ("monitor_captures"."incident_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "monitor_captures" ADD CONSTRAINT "monitor_captures_monitor_id_monitors_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."monitors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitor_captures" ADD CONSTRAINT "monitor_captures_incident_id_monitor_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."monitor_incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "monitor_captures_live_reference_idx" ON "monitor_captures" USING btree ("monitor_id") WHERE "monitor_captures"."kind" = 'reference' and "monitor_captures"."incident_id" is null;--> statement-breakpoint
CREATE INDEX "monitor_captures_incident_idx" ON "monitor_captures" USING btree ("incident_id");--> statement-breakpoint
CREATE INDEX "monitor_captures_monitor_taken_idx" ON "monitor_captures" USING btree ("monitor_id","taken_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "monitor_captures_taken_at_idx" ON "monitor_captures" USING btree ("taken_at") WHERE "monitor_captures"."image" is not null;--> statement-breakpoint
-- Ajouté à la main après la génération : une image JPEG est déjà compressée.
-- Le stockage EXTERNAL dit à TOAST de ne pas perdre du temps à tenter une
-- compression qui ne gagnera rien, et de sortir les octets de la table
-- principale — ce qui garde `monitor_captures` légère pour tout ce qui ne lit
-- que les métadonnées, c'est-à-dire pour tous les écrans.
ALTER TABLE "monitor_captures" ALTER COLUMN "image" SET STORAGE EXTERNAL;