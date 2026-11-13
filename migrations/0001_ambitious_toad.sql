CREATE TABLE "suppressions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid NOT NULL,
	"stream_id" text DEFAULT 'outbound' NOT NULL,
	"email" text NOT NULL,
	"reason" text DEFAULT 'ManualSuppression' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tracking_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"type" text NOT NULL,
	"user_agent" text,
	"ip_address" text,
	"original_link" text,
	"click_location" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "track_opens" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "track_links" text DEFAULT 'None' NOT NULL;--> statement-breakpoint
ALTER TABLE "streams" ADD COLUMN "description" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "streams" ADD COLUMN "message_stream_type" text DEFAULT 'outbound' NOT NULL;--> statement-breakpoint
ALTER TABLE "streams" ADD COLUMN "archived" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "suppressions" ADD CONSTRAINT "suppressions_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracking_events" ADD CONSTRAINT "tracking_events_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "suppressions_server_stream_email_idx" ON "suppressions" USING btree ("server_id","stream_id","email");--> statement-breakpoint
CREATE INDEX "suppressions_server_idx" ON "suppressions" USING btree ("server_id");--> statement-breakpoint
CREATE INDEX "tracking_events_message_idx" ON "tracking_events" USING btree ("message_id","created_at");