-- A declaration's reason is free text, and a manager's attestation carries it, so both are scrubbed like every other note. Rows are append-only, so only inserts.
DROP TRIGGER IF EXISTS "tip_declarations_scrub_sensitive" ON "tip_declarations";--> statement-breakpoint
CREATE TRIGGER "tip_declarations_scrub_sensitive" BEFORE INSERT ON "tip_declarations" FOR EACH ROW EXECUTE FUNCTION "scrub_sensitive_row"('reason', 'attestation');
