CREATE TABLE "notification_digest_groups" (
	"group_key" text PRIMARY KEY NOT NULL,
	"event" text NOT NULL,
	"window_ends_at" timestamp with time zone,
	"window_started_at" timestamp with time zone,
	"window_ms" integer DEFAULT 300000 NOT NULL,
	"escalation" integer DEFAULT 0 NOT NULL,
	"held_count" integer DEFAULT 0 NOT NULL,
	"first_held_at" timestamp with time zone,
	"last_held_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_digest_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_key" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"label" text NOT NULL,
	"detail" text,
	"url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_policy" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"window_ms" integer DEFAULT 300000 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text,
	CONSTRAINT "notification_policy_single_row" CHECK ("notification_policy"."id" = 1)
);
--> statement-breakpoint
ALTER TABLE "notification_digest_items" ADD CONSTRAINT "notification_digest_items_group_key_notification_digest_groups_group_key_fk" FOREIGN KEY ("group_key") REFERENCES "public"."notification_digest_groups"("group_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_policy" ADD CONSTRAINT "notification_policy_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notification_digest_items_group_idx" ON "notification_digest_items" USING btree ("group_key","occurred_at");