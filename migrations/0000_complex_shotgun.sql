CREATE TABLE "bounces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"type" text NOT NULL,
	"type_code" integer NOT NULL,
	"description" text,
	"email" text NOT NULL,
	"bounced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 10 NOT NULL,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "layouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid NOT NULL,
	"alias" text NOT NULL,
	"name" text NOT NULL,
	"html_body" text NOT NULL,
	"text_body" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"type" text NOT NULL,
	"details" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid NOT NULL,
	"stream_id" text DEFAULT 'outbound' NOT NULL,
	"from_address" text NOT NULL,
	"to_addresses" jsonb NOT NULL,
	"cc_addresses" jsonb,
	"bcc_addresses" jsonb,
	"reply_to" text,
	"subject" text NOT NULL,
	"html_body" text,
	"text_body" text,
	"raw_mail" text,
	"tag" text,
	"metadata" jsonb,
	"headers" jsonb,
	"attachments" jsonb,
	"status" text DEFAULT 'queued' NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "relay_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid NOT NULL,
	"stream_id" text DEFAULT 'outbound' NOT NULL,
	"host" text NOT NULL,
	"port" integer DEFAULT 587 NOT NULL,
	"username" text NOT NULL,
	"password_encrypted" text NOT NULL,
	"tls_mode" text DEFAULT 'starttls' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "server_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"name" text NOT NULL,
	"allowed_from" jsonb,
	"sandbox" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "server_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "servers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "servers_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "smtp_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid NOT NULL,
	"access_key" text NOT NULL,
	"secret_key_hash" text NOT NULL,
	"stream_id" text DEFAULT 'outbound' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "smtp_credentials_access_key_unique" UNIQUE("access_key")
);
--> statement-breakpoint
CREATE TABLE "streams" (
	"id" text PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid NOT NULL,
	"alias" text NOT NULL,
	"name" text NOT NULL,
	"subject" text NOT NULL,
	"html_body" text,
	"text_body" text,
	"layout_alias" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"webhook_id" uuid NOT NULL,
	"message_id" uuid,
	"trace_id" text NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"response_status" integer,
	"error" text,
	"delivered_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhooks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid NOT NULL,
	"url" text NOT NULL,
	"events" jsonb NOT NULL,
	"http_auth" jsonb,
	"http_headers" jsonb,
	"verified" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bounces" ADD CONSTRAINT "bounces_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "layouts" ADD CONSTRAINT "layouts_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_events" ADD CONSTRAINT "message_events_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relay_configs" ADD CONSTRAINT "relay_configs_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_tokens" ADD CONSTRAINT "server_tokens_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "smtp_credentials" ADD CONSTRAINT "smtp_credentials_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "streams" ADD CONSTRAINT "streams_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_webhook_id_webhooks_id_fk" FOREIGN KEY ("webhook_id") REFERENCES "public"."webhooks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bounces_message_idx" ON "bounces" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "bounces_type_idx" ON "bounces" USING btree ("type");--> statement-breakpoint
CREATE INDEX "jobs_status_runafter_idx" ON "jobs" USING btree ("status","run_after");--> statement-breakpoint
CREATE UNIQUE INDEX "layouts_server_alias_idx" ON "layouts" USING btree ("server_id","alias");--> statement-breakpoint
CREATE INDEX "message_events_message_idx" ON "message_events" USING btree ("message_id","created_at");--> statement-breakpoint
CREATE INDEX "messages_server_submitted_idx" ON "messages" USING btree ("server_id","submitted_at");--> statement-breakpoint
CREATE INDEX "messages_status_idx" ON "messages" USING btree ("status");--> statement-breakpoint
CREATE INDEX "messages_tag_idx" ON "messages" USING btree ("tag");--> statement-breakpoint
CREATE UNIQUE INDEX "relay_configs_server_stream_idx" ON "relay_configs" USING btree ("server_id","stream_id");--> statement-breakpoint
CREATE INDEX "server_tokens_server_idx" ON "server_tokens" USING btree ("server_id");--> statement-breakpoint
CREATE INDEX "smtp_credentials_server_idx" ON "smtp_credentials" USING btree ("server_id");--> statement-breakpoint
CREATE INDEX "streams_server_idx" ON "streams" USING btree ("server_id");--> statement-breakpoint
CREATE UNIQUE INDEX "templates_server_alias_idx" ON "templates" USING btree ("server_id","alias");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_webhook_idx" ON "webhook_deliveries" USING btree ("webhook_id","delivered_at");--> statement-breakpoint
CREATE INDEX "webhooks_server_idx" ON "webhooks" USING btree ("server_id");