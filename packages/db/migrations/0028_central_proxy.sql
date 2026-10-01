CREATE TABLE "proxy_links" (
	"target_id" uuid PRIMARY KEY NOT NULL,
	"proxy_id" uuid NOT NULL,
	"address" text NOT NULL,
	"source_address" text,
	"bindable" boolean DEFAULT false NOT NULL,
	"status" "proxy_status" DEFAULT 'unknown' NOT NULL,
	"last_checked_at" timestamp with time zone,
	"last_check_error" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "proxy_links" ADD CONSTRAINT "proxy_links_target_id_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."targets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proxy_links" ADD CONSTRAINT "proxy_links_proxy_id_proxies_id_fk" FOREIGN KEY ("proxy_id") REFERENCES "public"."proxies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proxy_links" ADD CONSTRAINT "proxy_links_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;