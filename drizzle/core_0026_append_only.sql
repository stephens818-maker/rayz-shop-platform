CREATE INDEX "refunds_sale_idx" ON "refunds" USING btree ("sale_id");--> statement-breakpoint
CREATE OR REPLACE FUNCTION "refuse_change_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: add a correcting row instead of changing or deleting one', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "audit_log_append_only" BEFORE UPDATE OR DELETE ON "audit_log" FOR EACH ROW EXECUTE FUNCTION "refuse_change_append_only"();--> statement-breakpoint
CREATE TRIGGER "gift_card_ledger_append_only" BEFORE UPDATE OR DELETE ON "gift_card_ledger" FOR EACH ROW EXECUTE FUNCTION "refuse_change_append_only"();
