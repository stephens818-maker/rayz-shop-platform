-- A pay question's detail, and the answers and notes in its history, are free text, so they're scrubbed like every other note.
DROP TRIGGER IF EXISTS "pay_questions_scrub_sensitive" ON "pay_questions";--> statement-breakpoint
CREATE TRIGGER "pay_questions_scrub_sensitive" BEFORE INSERT OR UPDATE OF "detail", "history" ON "pay_questions" FOR EACH ROW EXECUTE FUNCTION "scrub_sensitive_row"('detail', 'history');
