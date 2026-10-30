-- The note on a pay period marked sent to iSolved is free text, so it's scrubbed like every other note.
DROP TRIGGER IF EXISTS "payroll_export_sends_scrub_sensitive" ON "payroll_export_sends";--> statement-breakpoint
CREATE TRIGGER "payroll_export_sends_scrub_sensitive" BEFORE INSERT OR UPDATE OF "note" ON "payroll_export_sends" FOR EACH ROW EXECUTE FUNCTION "scrub_sensitive_row"('note');
