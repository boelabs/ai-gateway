CREATE TABLE "provider_credentials" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"adapter_key" text NOT NULL,
	"secret" jsonb NOT NULL,
	"hint" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"fields" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_credentials_adapter_key_format" CHECK ("provider_credentials"."adapter_key" ~ '^[a-z0-9]+$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "provider_credentials_name_idx" ON "provider_credentials" USING btree (lower("name"));--> statement-breakpoint
CREATE INDEX "provider_credentials_adapter_key_idx" ON "provider_credentials" USING btree ("adapter_key");