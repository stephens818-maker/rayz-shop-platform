-- Rayz Assistant: assistant_conversations and assistant_messages keep each person's questions and answers (the numbers shown and the links, never the data the tools read), and are counted for the per-minute and per-day limits; assistant_actions holds a blast or purchase order the assistant drafted until the person confirms or cancels it. brand_settings.assistant is the on/off switch per role and the limits. Free text is scrubbed like every other note. Brand Admins can change the settings. Additive only.
ALTER TABLE "brand_settings" ADD COLUMN IF NOT EXISTS "assistant" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
CREATE TABLE "assistant_conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"staff_id" uuid NOT NULL REFERENCES "staff"("id") ON DELETE cascade,
	"title" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX "assistant_conversations_staff_idx" ON "assistant_conversations" USING btree ("staff_id","updated_at");--> statement-breakpoint
CREATE TABLE "assistant_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL REFERENCES "assistant_conversations"("id") ON DELETE cascade,
	"staff_id" uuid NOT NULL REFERENCES "staff"("id") ON DELETE cascade,
	"role" text NOT NULL,
	"body" text NOT NULL,
	"cards" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tools" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assistant_messages_role" CHECK ("role" in ('user', 'assistant'))
);--> statement-breakpoint
CREATE INDEX "assistant_messages_conversation_idx" ON "assistant_messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "assistant_messages_staff_idx" ON "assistant_messages" USING btree ("staff_id","created_at");--> statement-breakpoint
CREATE TABLE "assistant_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL REFERENCES "assistant_conversations"("id") ON DELETE cascade,
	"staff_id" uuid NOT NULL REFERENCES "staff"("id") ON DELETE cascade,
	"kind" text NOT NULL,
	"params" jsonb NOT NULL,
	"summary" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	CONSTRAINT "assistant_actions_kind" CHECK ("kind" in ('draft_blast', 'draft_po')),
	CONSTRAINT "assistant_actions_status" CHECK ("status" in ('pending', 'confirmed', 'cancelled', 'failed'))
);--> statement-breakpoint
CREATE INDEX "assistant_actions_staff_idx" ON "assistant_actions" USING btree ("staff_id","created_at");--> statement-breakpoint
CREATE TRIGGER "assistant_conversations_scrub_sensitive" BEFORE INSERT OR UPDATE OF "title" ON "assistant_conversations" FOR EACH ROW EXECUTE FUNCTION "scrub_sensitive_row"('title');--> statement-breakpoint
CREATE TRIGGER "assistant_messages_scrub_sensitive" BEFORE INSERT OR UPDATE OF "body", "cards", "tools" ON "assistant_messages" FOR EACH ROW EXECUTE FUNCTION "scrub_sensitive_row"('body', 'cards', 'tools');--> statement-breakpoint
CREATE TRIGGER "assistant_actions_scrub_sensitive" BEFORE INSERT OR UPDATE OF "params", "summary", "result" ON "assistant_actions" FOR EACH ROW EXECUTE FUNCTION "scrub_sensitive_row"('params', 'summary', 'result');--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" || '["assistant.settings"]'::jsonb WHERE "key" = 'brand_admin' AND NOT ("permissions" ? 'assistant.settings');
