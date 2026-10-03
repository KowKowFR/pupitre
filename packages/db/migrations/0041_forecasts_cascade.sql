-- Les prévisions dont le sujet a déjà disparu (supprimé avant cette migration,
-- dans l'intervalle entre deux balayages) : sans ce ménage, les clés étrangères
-- ci-dessous refuseraient de se poser.
DELETE FROM "forecasts" f
WHERE (f."subject_type" = 'target' AND NOT EXISTS (SELECT 1 FROM "targets" s WHERE s."id"::text = f."subject_id"))
   OR (f."subject_type" = 'monitor' AND NOT EXISTS (SELECT 1 FROM "monitors" s WHERE s."id"::text = f."subject_id"))
   OR (f."subject_type" = 'route' AND NOT EXISTS (SELECT 1 FROM "routes" s WHERE s."id"::text = f."subject_id"))
   OR (f."subject_type" = 'application' AND NOT EXISTS (SELECT 1 FROM "applications" s WHERE s."id"::text = f."subject_id"));--> statement-breakpoint
ALTER TABLE "forecasts" ADD COLUMN "target_id" uuid GENERATED ALWAYS AS (case when subject_type = 'target' then subject_id::uuid end) STORED;--> statement-breakpoint
ALTER TABLE "forecasts" ADD COLUMN "monitor_id" uuid GENERATED ALWAYS AS (case when subject_type = 'monitor' then subject_id::uuid end) STORED;--> statement-breakpoint
ALTER TABLE "forecasts" ADD COLUMN "route_id" uuid GENERATED ALWAYS AS (case when subject_type = 'route' then subject_id::uuid end) STORED;--> statement-breakpoint
ALTER TABLE "forecasts" ADD COLUMN "application_id" uuid GENERATED ALWAYS AS (case when subject_type = 'application' then subject_id::uuid end) STORED;--> statement-breakpoint
ALTER TABLE "forecasts" ADD CONSTRAINT "forecasts_target_id_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."targets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forecasts" ADD CONSTRAINT "forecasts_monitor_id_monitors_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."monitors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forecasts" ADD CONSTRAINT "forecasts_route_id_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."routes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forecasts" ADD CONSTRAINT "forecasts_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;