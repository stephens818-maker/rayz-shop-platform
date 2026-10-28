-- Training rates: a version a locked pay period used stays in the history even when it starts after today (a period locked before it ends). Replaces core_0143's guard function; additive only.
CREATE OR REPLACE FUNCTION "staff_training_rates_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
	locked date;
BEGIN
	IF TG_OP = 'UPDATE' THEN
		RAISE EXCEPTION 'A training rate can''t be changed once saved; add a new one instead' USING ERRCODE = 'check_violation';
	END IF;
	SELECT max("period_end") INTO locked FROM "payroll_runs";
	IF TG_OP = 'DELETE' THEN
		IF NOT EXISTS (SELECT 1 FROM "staff" WHERE "id" = OLD."staff_id") THEN RETURN OLD; END IF;
		IF OLD."effective_from" > (now() AT TIME ZONE 'America/Chicago')::date AND (locked IS NULL OR OLD."effective_from" > locked) THEN RETURN OLD; END IF;
		RAISE EXCEPTION 'Only a training rate that hasn''t started yet, and no locked pay period used, can be deleted' USING ERRCODE = 'check_violation';
	END IF;
	IF locked IS NOT NULL AND NEW."effective_from" <= locked THEN
		RAISE EXCEPTION 'A training rate must start after the last locked pay period (%)', locked USING ERRCODE = 'check_violation';
	END IF;
	RETURN NEW;
END $$;
