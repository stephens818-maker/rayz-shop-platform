-- Card numbers, bank details, SSNs, EINs and the like are collected only by Stripe. These triggers remove them from every free-text column anyway (notes, reasons, message bodies, audit details, import errors), whoever writes the row. Same rules as src/lib/sensitive.ts; keep the two in step.
CREATE OR REPLACE FUNCTION "luhn_ok"(d text) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
	s int := 0;
	n int;
	len int := length(d);
BEGIN
	FOR i IN 0..len - 1 LOOP
		n := ascii(substr(d, len - i, 1)) - 48;
		IF i % 2 = 1 THEN
			n := n * 2;
			IF n > 9 THEN n := n - 9; END IF;
		END IF;
		s := s + n;
	END LOOP;
	RETURN len > 0 AND s % 10 = 0;
END
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "scrub_sensitive_text"(t text) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
	m text;
	d text;
BEGIN
	IF t IS NULL OR t !~ '[0-9]' THEN RETURN t; END IF;
	FOR m IN SELECT DISTINCT (regexp_matches(t, '(?<![0-9A-Za-z_+-])(?<![0-9]\.)(?:[2-6][0-9]{12,18}|[2-6][0-9]{3}(?:[ -][0-9]{4}){2,3}(?:[ -][0-9]{1,3})?|3[47][0-9]{2}[ -][0-9]{6}[ -][0-9]{5})(?![0-9A-Za-z_-])(?!\.[0-9])', 'g'))[1] LOOP
		d := regexp_replace(m, '[^0-9]', '', 'g');
		-- m is only digits, spaces and dashes, so it can sit in a pattern as is.
		IF length(d) BETWEEN 13 AND 19 AND "luhn_ok"(d) THEN t := regexp_replace(t, '(?<![0-9A-Za-z_+-])(?<![0-9]\.)' || m || '(?![0-9A-Za-z_-])(?!\.[0-9])', '[card number removed]', 'g'); END IF;
	END LOOP;
	t := regexp_replace(t, '(?<![0-9A-Za-z_+-])(?<![0-9]\.)[0-9]{3}([ -])[0-9]{2}\1[0-9]{4}(?![0-9A-Za-z_-])(?!\.[0-9])', '[SSN removed]', 'g');
	RETURN regexp_replace(t, '(?<![0-9A-Za-z_+-])(?<![0-9]\.)[0-9]{2}-[0-9]{7}(?![0-9A-Za-z_-])(?!\.[0-9])', '[EIN removed]', 'g');
END
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "is_forbidden_key"(k text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
	SELECT lower(regexp_replace(k, '[^a-zA-Z0-9]+', '_', 'g')) ~ '^(routing(_?(number|no|num))?|aba(_?(number|routing))?|(bank_?)?account_?(number|no|num)|acct_?(number|no|num)|iban|swift(_?code)?|bic|ssn(_?last_?4)?|social_?security(_?number)?|tax_?id(_?number)?|tin|itin|ein|fein|id_?number|personal_?id_?number|dob|date_?of_?birth|birth_?date|card_?(number|no|num)|cc_?(number|num|no)|pan|cvc2?|cvv2?|security_?code|verification_?document|document_?(front|back))$'
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "scrub_sensitive_jsonb"(j jsonb) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
	out jsonb;
BEGIN
	CASE jsonb_typeof(j)
		WHEN 'string' THEN
			RETURN to_jsonb("scrub_sensitive_text"(j #>> '{}'));
		WHEN 'number' THEN
			IF j::text ~ '^[2-6][0-9]{12,18}$' AND "luhn_ok"(j::text) THEN RETURN to_jsonb('[card number removed]'::text); END IF;
			RETURN j;
		WHEN 'array' THEN
			SELECT coalesce(jsonb_agg("scrub_sensitive_jsonb"(e) ORDER BY i), '[]'::jsonb) INTO out FROM jsonb_array_elements(j) WITH ORDINALITY AS a(e, i);
			RETURN out;
		WHEN 'object' THEN
			SELECT coalesce(jsonb_object_agg(key, CASE WHEN "is_forbidden_key"(key) THEN to_jsonb('[removed]'::text) ELSE "scrub_sensitive_jsonb"(value) END), '{}'::jsonb) INTO out FROM jsonb_each(j);
			RETURN out;
		ELSE
			RETURN j;
	END CASE;
END
$$;--> statement-breakpoint
-- Arguments are the columns to scrub; text and jsonb both work.
CREATE OR REPLACE FUNCTION "scrub_sensitive_row"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
	r jsonb := to_jsonb(NEW);
	patch jsonb := '{}'::jsonb;
	v jsonb;
	s jsonb;
BEGIN
	FOR i IN 0..TG_NARGS - 1 LOOP
		v := r -> TG_ARGV[i];
		IF v IS NULL OR jsonb_typeof(v) = 'null' THEN CONTINUE; END IF;
		s := "scrub_sensitive_jsonb"(v);
		IF s IS DISTINCT FROM v THEN patch := patch || jsonb_build_object(TG_ARGV[i], s); END IF;
	END LOOP;
	IF patch <> '{}'::jsonb THEN NEW := jsonb_populate_record(NEW, patch); END IF;
	RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER "appointment_outreach_scrub_sensitive" BEFORE INSERT OR UPDATE OF "flag_reason" ON "appointment_outreach" FOR EACH ROW EXECUTE FUNCTION "scrub_sensitive_row"('flag_reason');--> statement-breakpoint
CREATE TRIGGER "appointment_times_scrub_sensitive" BEFORE INSERT OR UPDATE OF "review_note" ON "appointment_times" FOR EACH ROW EXECUTE FUNCTION "scrub_sensitive_row"('review_note');--> statement-breakpoint
CREATE TRIGGER "appointments_scrub_sensitive" BEFORE INSERT OR UPDATE OF "notes" ON "appointments" FOR EACH ROW EXECUTE FUNCTION "scrub_sensitive_row"('notes');--> statement-breakpoint
CREATE TRIGGER "audit_log_scrub_sensitive" BEFORE INSERT ON "audit_log" FOR EACH ROW EXECUTE FUNCTION "scrub_sensitive_row"('details');--> statement-breakpoint
CREATE TRIGGER "call_ins_scrub_sensitive" BEFORE INSERT OR UPDATE OF "note", "reason" ON "call_ins" FOR EACH ROW EXECUTE FUNCTION "scrub_sensitive_row"('note', 'reason');--> statement-breakpoint
CREATE TRIGGER "cash_drawers_scrub_sensitive" BEFORE INSERT OR UPDATE OF "notes" ON "cash_drawers" FOR EACH ROW EXECUTE FUNCTION "scrub_sensitive_row"('notes');--> statement-breakpoint
CREATE TRIGGER "client_access_log_scrub_sensitive" BEFORE INSERT OR UPDATE OF "detail", "reason" ON "client_access_log" FOR EACH ROW EXECUTE FUNCTION "scrub_sensitive_row"('detail', 'reason');--> statement-breakpoint
CREATE TRIGGER "client_ratings_scrub_sensitive" BEFORE INSERT OR UPDATE OF "note" ON "client_ratings" FOR EACH ROW EXECUTE FUNCTION "scrub_sensitive_row"('note');--> statement-breakpoint
CREATE TRIGGER "clock_block_releases_scrub_sensitive" BEFORE INSERT OR UPDATE OF "note" ON "clock_block_releases" FOR EACH ROW EXECUTE FUNCTION "scrub_sensitive_row"('note');--> statement-breakpoint
CREATE TRIGGER "customers_scrub_sensitive" BEFORE INSERT OR UPDATE OF "notes", "custom_fields" ON "customers" FOR EACH ROW EXECUTE FUNCTION "scrub_sensitive_row"('notes', 'custom_fields');--> statement-breakpoint
CREATE TRIGGER "import_runs_scrub_sensitive" BEFORE INSERT OR UPDATE OF "errors" ON "import_runs" FOR EACH ROW EXECUTE FUNCTION "scrub_sensitive_row"('errors');--> statement-breakpoint
CREATE TRIGGER "inventory_ledger_scrub_sensitive" BEFORE INSERT ON "inventory_ledger" FOR EACH ROW EXECUTE FUNCTION "scrub_sensitive_row"('note', 'reason');--> statement-breakpoint
CREATE TRIGGER "messages_scrub_sensitive" BEFORE INSERT OR UPDATE OF "body" ON "messages" FOR EACH ROW EXECUTE FUNCTION "scrub_sensitive_row"('body');--> statement-breakpoint
CREATE TRIGGER "notification_jobs_scrub_sensitive" BEFORE INSERT OR UPDATE OF "body", "subject" ON "notification_jobs" FOR EACH ROW EXECUTE FUNCTION "scrub_sensitive_row"('body', 'subject');--> statement-breakpoint
CREATE TRIGGER "payroll_overrides_scrub_sensitive" BEFORE INSERT OR UPDATE OF "reason" ON "payroll_overrides" FOR EACH ROW EXECUTE FUNCTION "scrub_sensitive_row"('reason');--> statement-breakpoint
CREATE TRIGGER "po_receipts_scrub_sensitive" BEFORE INSERT OR UPDATE OF "note" ON "po_receipts" FOR EACH ROW EXECUTE FUNCTION "scrub_sensitive_row"('note');--> statement-breakpoint
CREATE TRIGGER "purchase_orders_scrub_sensitive" BEFORE INSERT OR UPDATE OF "cancel_reason", "notes" ON "purchase_orders" FOR EACH ROW EXECUTE FUNCTION "scrub_sensitive_row"('cancel_reason', 'notes');--> statement-breakpoint
CREATE TRIGGER "refunds_scrub_sensitive" BEFORE INSERT OR UPDATE OF "reason" ON "refunds" FOR EACH ROW EXECUTE FUNCTION "scrub_sensitive_row"('reason');--> statement-breakpoint
CREATE TRIGGER "sale_items_scrub_sensitive" BEFORE INSERT OR UPDATE OF "override_reason" ON "sale_items" FOR EACH ROW EXECUTE FUNCTION "scrub_sensitive_row"('override_reason');--> statement-breakpoint
CREATE TRIGGER "sales_scrub_sensitive" BEFORE INSERT OR UPDATE OF "void_reason" ON "sales" FOR EACH ROW EXECUTE FUNCTION "scrub_sensitive_row"('void_reason');--> statement-breakpoint
CREATE TRIGGER "shop_closures_scrub_sensitive" BEFORE INSERT OR UPDATE OF "reason" ON "shop_closures" FOR EACH ROW EXECUTE FUNCTION "scrub_sensitive_row"('reason');--> statement-breakpoint
CREATE TRIGGER "shop_payment_accounts_scrub_sensitive" BEFORE INSERT OR UPDATE OF "disabled_reason" ON "shop_payment_accounts" FOR EACH ROW EXECUTE FUNCTION "scrub_sensitive_row"('disabled_reason');--> statement-breakpoint
CREATE TRIGGER "shop_payouts_scrub_sensitive" BEFORE INSERT OR UPDATE OF "failure_message" ON "shop_payouts" FOR EACH ROW EXECUTE FUNCTION "scrub_sensitive_row"('failure_message');--> statement-breakpoint
CREATE TRIGGER "shops_scrub_sensitive" BEFORE INSERT OR UPDATE OF "closed_note" ON "shops" FOR EACH ROW EXECUTE FUNCTION "scrub_sensitive_row"('closed_note');--> statement-breakpoint
CREATE TRIGGER "staff_payout_accounts_scrub_sensitive" BEFORE INSERT OR UPDATE OF "disabled_reason" ON "staff_payout_accounts" FOR EACH ROW EXECUTE FUNCTION "scrub_sensitive_row"('disabled_reason');--> statement-breakpoint
CREATE TRIGGER "stock_counts_scrub_sensitive" BEFORE INSERT OR UPDATE OF "note" ON "stock_counts" FOR EACH ROW EXECUTE FUNCTION "scrub_sensitive_row"('note');--> statement-breakpoint
CREATE TRIGGER "stock_transfers_scrub_sensitive" BEFORE INSERT OR UPDATE OF "note" ON "stock_transfers" FOR EACH ROW EXECUTE FUNCTION "scrub_sensitive_row"('note');--> statement-breakpoint
CREATE TRIGGER "time_block_series_scrub_sensitive" BEFORE INSERT OR UPDATE OF "note", "reason" ON "time_block_series" FOR EACH ROW EXECUTE FUNCTION "scrub_sensitive_row"('note', 'reason');--> statement-breakpoint
CREATE TRIGGER "time_blocks_scrub_sensitive" BEFORE INSERT OR UPDATE OF "note", "reason" ON "time_blocks" FOR EACH ROW EXECUTE FUNCTION "scrub_sensitive_row"('note', 'reason');--> statement-breakpoint
CREATE TRIGGER "time_entries_scrub_sensitive" BEFORE INSERT OR UPDATE OF "note" ON "time_entries" FOR EACH ROW EXECUTE FUNCTION "scrub_sensitive_row"('note');--> statement-breakpoint
CREATE TRIGGER "time_off_requests_scrub_sensitive" BEFORE INSERT OR UPDATE OF "decision_note", "note", "reason" ON "time_off_requests" FOR EACH ROW EXECUTE FUNCTION "scrub_sensitive_row"('decision_note', 'note', 'reason');--> statement-breakpoint
CREATE TRIGGER "time_punch_edits_scrub_sensitive" BEFORE INSERT ON "time_punch_edits" FOR EACH ROW EXECUTE FUNCTION "scrub_sensitive_row"('reason', 'before', 'after');--> statement-breakpoint
CREATE TRIGGER "time_punches_scrub_sensitive" BEFORE INSERT OR UPDATE OF "note" ON "time_punches" FOR EACH ROW EXECUTE FUNCTION "scrub_sensitive_row"('note');--> statement-breakpoint
CREATE TRIGGER "timesheets_scrub_sensitive" BEFORE INSERT OR UPDATE OF "manager_note" ON "timesheets" FOR EACH ROW EXECUTE FUNCTION "scrub_sensitive_row"('manager_note');--> statement-breakpoint
CREATE TRIGGER "tip_ledger_scrub_sensitive" BEFORE INSERT OR UPDATE OF "reason" ON "tip_ledger" FOR EACH ROW EXECUTE FUNCTION "scrub_sensitive_row"('reason');--> statement-breakpoint
CREATE TRIGGER "tip_payout_batches_scrub_sensitive" BEFORE INSERT OR UPDATE OF "notes" ON "tip_payout_batches" FOR EACH ROW EXECUTE FUNCTION "scrub_sensitive_row"('notes');--> statement-breakpoint
CREATE TRIGGER "tip_payouts_scrub_sensitive" BEFORE INSERT OR UPDATE OF "failure_message", "hold_reason" ON "tip_payouts" FOR EACH ROW EXECUTE FUNCTION "scrub_sensitive_row"('failure_message', 'hold_reason');--> statement-breakpoint
CREATE TRIGGER "vendors_scrub_sensitive" BEFORE INSERT OR UPDATE OF "notes" ON "vendors" FOR EACH ROW EXECUTE FUNCTION "scrub_sensitive_row"('notes');--> statement-breakpoint
CREATE TRIGGER "waitlist_entries_scrub_sensitive" BEFORE INSERT OR UPDATE OF "notes" ON "waitlist_entries" FOR EACH ROW EXECUTE FUNCTION "scrub_sensitive_row"('notes');--> statement-breakpoint
-- Rows written before these triggers: scrubbed in place, append-only tables included (their guards are off only for this statement), with one audit entry saying how many changed.
DO $$
DECLARE
	t record;
	n int;
	total int := 0;
	changed jsonb := '{}'::jsonb;
	guard text;
BEGIN
	FOR t IN
		SELECT tg.tgrelid::regclass::text AS tbl, a.attname AS col, format_type(a.atttypid, a.atttypmod) AS typ
		FROM pg_trigger tg
		JOIN pg_attribute a ON a.attrelid = tg.tgrelid AND a.attname = ANY (string_to_array(encode(tg.tgargs, 'escape'), '\000'))
		WHERE tg.tgname LIKE '%\_scrub\_sensitive' AND NOT tg.tgisinternal
	LOOP
		guard := CASE t.tbl WHEN 'audit_log' THEN 'audit_log_append_only' WHEN 'inventory_ledger' THEN 'inventory_ledger_append_only' WHEN 'time_punch_edits' THEN 'time_punch_edits_append_only' WHEN 'tip_ledger' THEN 'tip_ledger_guard' END;
		IF guard IS NOT NULL THEN EXECUTE format('ALTER TABLE %I DISABLE TRIGGER %I', t.tbl, guard); END IF;
		EXECUTE format(
			'UPDATE %1$I SET %2$I = %3$s(%2$I) WHERE %2$I IS DISTINCT FROM %3$s(%2$I)',
			t.tbl, t.col, CASE WHEN t.typ = 'jsonb' THEN '"scrub_sensitive_jsonb"' ELSE '"scrub_sensitive_text"' END
		);
		GET DIAGNOSTICS n = ROW_COUNT;
		IF guard IS NOT NULL THEN EXECUTE format('ALTER TABLE %I ENABLE TRIGGER %I', t.tbl, guard); END IF;
		IF n > 0 THEN
			total := total + n;
			changed := changed || jsonb_build_object(t.tbl || '.' || t.col, n);
		END IF;
	END LOOP;
	IF total > 0 THEN
		INSERT INTO "audit_log" ("actor_label", "action", "entity", "details") VALUES ('system', 'privacy.scrub_existing', 'database', jsonb_build_object('rows', total, 'columns', changed));
	END IF;
END
$$;
