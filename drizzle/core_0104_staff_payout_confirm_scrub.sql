-- A barber's note disputing the Squire amount at the payout cutover is free text, so it's scrubbed like every other note.
DROP TRIGGER IF EXISTS "staff_payout_confirmations_scrub_sensitive" ON "staff_payout_confirmations";--> statement-breakpoint
CREATE TRIGGER "staff_payout_confirmations_scrub_sensitive" BEFORE INSERT OR UPDATE OF "note" ON "staff_payout_confirmations" FOR EACH ROW EXECUTE FUNCTION "scrub_sensitive_row"('note');
