CREATE TYPE "public"."waf_mode" AS ENUM('block', 'detect', 'off');--> statement-breakpoint
ALTER TABLE "routes" ADD COLUMN "waf" "waf_mode" DEFAULT 'block' NOT NULL;