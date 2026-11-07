-- Phone agent: each call's transcript, line by line (what the agent said, what the caller pressed or said, and what the line did), and a staff follow-up on a call (who, when, a note). Free text is scrubbed of card and bank numbers. Additive only.
CREATE TABLE IF NOT EXISTS "call_transcript_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"call_log_id" uuid NOT NULL REFERENCES "call_logs"("id") ON DELETE cascade,
	"n" bigint GENERATED ALWAYS AS IDENTITY,
	"speaker" text NOT NULL,
	"text" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "call_transcript_lines_speaker_chk" CHECK ("speaker" in ('agent', 'caller', 'line')),
	CONSTRAINT "call_transcript_lines_text_chk" CHECK (char_length("text") BETWEEN 1 AND 1000)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "call_transcript_lines_call_idx" ON "call_transcript_lines" ("call_log_id", "n");--> statement-breakpoint
DROP TRIGGER IF EXISTS "call_transcript_lines_scrub_sensitive" ON "call_transcript_lines";--> statement-breakpoint
CREATE TRIGGER "call_transcript_lines_scrub_sensitive" BEFORE INSERT OR UPDATE OF "text" ON "call_transcript_lines" FOR EACH ROW EXECUTE FUNCTION "scrub_sensitive_row"('text');--> statement-breakpoint
ALTER TABLE "call_logs" ADD COLUMN IF NOT EXISTS "followed_up_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "call_logs" ADD COLUMN IF NOT EXISTS "followed_up_by" uuid REFERENCES "staff"("id") ON DELETE set null;--> statement-breakpoint
ALTER TABLE "call_logs" ADD COLUMN IF NOT EXISTS "follow_up_note" text;--> statement-breakpoint
ALTER TABLE "call_logs" DROP CONSTRAINT IF EXISTS "call_logs_follow_up_note_chk";--> statement-breakpoint
ALTER TABLE "call_logs" ADD CONSTRAINT "call_logs_follow_up_note_chk" CHECK ("follow_up_note" IS NULL OR char_length("follow_up_note") <= 500);--> statement-breakpoint
DROP TRIGGER IF EXISTS "call_logs_scrub_sensitive" ON "call_logs";--> statement-breakpoint
CREATE TRIGGER "call_logs_scrub_sensitive" BEFORE INSERT OR UPDATE OF "follow_up_note" ON "call_logs" FOR EACH ROW EXECUTE FUNCTION "scrub_sensitive_row"('follow_up_note');
