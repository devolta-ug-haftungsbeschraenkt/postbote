-- Composite-PK für Streams: Stream-IDs gelten pro Server, nicht global
-- (Multi-Tenancy-Fix). Constraint-Name gegen information_schema verifiziert.
ALTER TABLE "streams" DROP CONSTRAINT "streams_pkey";--> statement-breakpoint
ALTER TABLE "streams" ADD CONSTRAINT "streams_server_id_id_pk" PRIMARY KEY("server_id","id");
