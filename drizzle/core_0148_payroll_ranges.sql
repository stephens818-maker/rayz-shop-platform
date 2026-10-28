-- Payroll Report by date range (Charles, Oct 28): approve, lock and the iSolved files take a pay period (the usual run) or a run of whole Sunday–Saturday workweeks for the shops picked, never dates that overlap a locked run. An approval is keyed by its dates and what it covers (scope: '' for a pay period, the sorted shop ids for a run of workweeks). Payroll setup's rates become effective-dated so a range's commission is at the rate in effect on each sale date. Additive only.
ALTER TABLE "payroll_approvals" ADD COLUMN IF NOT EXISTS "scope" text DEFAULT '' NOT NULL;--> statement-breakpoint
DROP INDEX IF EXISTS "payroll_approvals_active_uq";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payroll_approvals_active_uq" ON "payroll_approvals" USING btree ("period_start", "period_end", "scope") WHERE "revoked_at" IS NULL;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "payroll_approvals_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payroll_approvals rows are never deleted: revoke the approval with a reason' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."revoked_at" IS NOT NULL
    OR NEW."id" IS DISTINCT FROM OLD."id" OR NEW."period_start" IS DISTINCT FROM OLD."period_start" OR NEW."period_end" IS DISTINCT FROM OLD."period_end" OR NEW."scope" IS DISTINCT FROM OLD."scope"
    OR NEW."figures_hash" IS DISTINCT FROM OLD."figures_hash" OR NEW."totals" IS DISTINCT FROM OLD."totals" OR NEW."note" IS DISTINCT FROM OLD."note"
    OR NEW."approved_at" IS DISTINCT FROM OLD."approved_at" OR NEW."approved_by" IS DISTINCT FROM OLD."approved_by" THEN
    RAISE EXCEPTION 'An approval is only ever revoked, once: approve again instead of changing one' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
-- A pay group's locked runs never overlap: two runs racing for overlapping dates take turns on the group's lock.
CREATE OR REPLACE FUNCTION "payroll_runs_no_overlap"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  hit record;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('payroll_runs:' || NEW."pay_group_id"::text));
  SELECT "period_start", "period_end" INTO hit FROM "payroll_runs"
    WHERE "pay_group_id" = NEW."pay_group_id" AND "id" IS DISTINCT FROM NEW."id" AND "period_start" <= NEW."period_end" AND "period_end" >= NEW."period_start"
    LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'These dates overlap a locked run (% to %)', hit."period_start", hit."period_end" USING ERRCODE = 'exclusion_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "payroll_runs_no_overlap" ON "payroll_runs";--> statement-breakpoint
CREATE TRIGGER "payroll_runs_no_overlap" BEFORE INSERT OR UPDATE OF "pay_group_id", "period_start", "period_end" ON "payroll_runs" FOR EACH ROW EXECUTE FUNCTION "payroll_runs_no_overlap"();--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payroll_rate_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"staff_id" uuid NOT NULL REFERENCES "staff"("id") ON DELETE cascade,
	"shop_id" uuid REFERENCES "shops"("id") ON DELETE cascade,
	"effective_from" date NOT NULL,
	"hourly_rate" double precision DEFAULT 0 NOT NULL,
	"service_pct" double precision DEFAULT 0 NOT NULL,
	"product_pct" double precision DEFAULT 0.15 NOT NULL,
	"created_by" uuid REFERENCES "staff"("id") ON DELETE set null,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payroll_rate_versions_uq" UNIQUE NULLS NOT DISTINCT ("staff_id", "shop_id", "effective_from")
);--> statement-breakpoint
DROP TRIGGER IF EXISTS "payroll_rate_versions_history" ON "payroll_rate_versions";--> statement-breakpoint
-- Every rate saved so far has applied to every date: it's the first version.
INSERT INTO "payroll_rate_versions" ("staff_id", "shop_id", "effective_from", "hourly_rate", "service_pct", "product_pct")
	SELECT "staff_id", "shop_id", '2000-01-01', "hourly_rate", "service_pct", "product_pct" FROM "payroll_rates"
	ON CONFLICT DO NOTHING;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "payroll_rate_versions_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
	locked date;
BEGIN
	SELECT max("period_end") INTO locked FROM "payroll_runs";
	IF TG_OP = 'DELETE' THEN
		IF NOT EXISTS (SELECT 1 FROM "staff" WHERE "id" = OLD."staff_id") OR (OLD."shop_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "shops" WHERE "id" = OLD."shop_id")) THEN RETURN OLD; END IF;
		IF locked IS NULL OR OLD."effective_from" > locked THEN RETURN OLD; END IF;
		RAISE EXCEPTION 'A locked pay period used this pay rate, so it stays in the history' USING ERRCODE = 'check_violation';
	END IF;
	IF locked IS NOT NULL AND (NEW."effective_from" <= locked OR (TG_OP = 'UPDATE' AND OLD."effective_from" <= locked)) THEN
		RAISE EXCEPTION 'A pay rate must start after the last locked pay period (%)', locked USING ERRCODE = 'check_violation';
	END IF;
	RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "payroll_rate_versions_history" BEFORE INSERT OR UPDATE OR DELETE ON "payroll_rate_versions" FOR EACH ROW EXECUTE FUNCTION "payroll_rate_versions_guard"();
