CREATE TABLE "spend_ledger" (
	"id" text PRIMARY KEY NOT NULL,
	"virtual_key_id" uuid NOT NULL,
	"cents" numeric(20, 10) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "spend_ledger_created_at_idx" ON "spend_ledger" USING btree ("created_at");