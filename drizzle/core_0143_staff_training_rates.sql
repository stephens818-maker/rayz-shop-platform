-- Training pay (Charles, Oct 28): each employee's flat hourly training rate, effective-dated, on their Staff page. Training pay is training hours × the rate in effect that day, its own line outside the greater-of, in Labor Cost. A version is never changed once saved: a change is a new version from a date after the last locked pay period, and only one that hasn't started yet can be deleted. Payroll setup's training rate stays the fallback. Additive only.
CREATE TABLE IF NOT EXISTS "staff_training_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"staff_id" uuid NOT NULL REFERENCES "staff"("id") ON DELETE cascade,
	"effective_from" date NOT NULL,
	"rate_cents" integer NOT NULL,
	"created_by" uuid REFERENCES "staff"("id") ON DELETE set null,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "staff_training_rates_rate" CHECK ("rate_cents" BETWEEN 0 AND 50000)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "staff_training_rates_uq" ON "staff_training_rates" USING btree ("staff_id", "effective_from");--> statement-breakpoint
CREATE OR REPLACE FUNCTION "staff_training_rates_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
	locked date;
BEGIN
	IF TG_OP = 'UPDATE' THEN
		RAISE EXCEPTION 'A training rate can''t be changed once saved; add a new one instead' USING ERRCODE = 'check_violation';
	END IF;
	IF TG_OP = 'DELETE' THEN
		IF OLD."effective_from" > (now() AT TIME ZONE 'America/Chicago')::date OR NOT EXISTS (SELECT 1 FROM "staff" WHERE "id" = OLD."staff_id") THEN RETURN OLD; END IF;
		RAISE EXCEPTION 'Only a training rate that hasn''t started yet can be deleted' USING ERRCODE = 'check_violation';
	END IF;
	SELECT max("period_end") INTO locked FROM "payroll_runs";
	IF locked IS NOT NULL AND NEW."effective_from" <= locked THEN
		RAISE EXCEPTION 'A training rate must start after the last locked pay period (%)', locked USING ERRCODE = 'check_violation';
	END IF;
	RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "staff_training_rates_history" ON "staff_training_rates";--> statement-breakpoint
CREATE TRIGGER "staff_training_rates_history" BEFORE INSERT OR UPDATE OR DELETE ON "staff_training_rates" FOR EACH ROW EXECUTE FUNCTION "staff_training_rates_guard"();
