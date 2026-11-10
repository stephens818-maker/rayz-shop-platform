-- Legal entities (ST-I14): payroll_employers is the legal-entity table (one FEIN, its iSolved company code, the last 4 of its EIN). Each entity's state registrations, the shop's entity on the shop itself, and the entity on every time, tip, transfer and payroll export row.
CREATE TABLE "payroll_employer_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employer_id" uuid NOT NULL,
	"state" text NOT NULL,
	"withholding_id_last4" text,
	"unemployment_id_last4" text,
	"registered_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payroll_employer_states_uq" UNIQUE("employer_id","state"),
	CONSTRAINT "payroll_employer_states_state" CHECK ("payroll_employer_states"."state" ~ '^[A-Z]{2}$'),
	CONSTRAINT "payroll_employer_states_last4" CHECK (("payroll_employer_states"."withholding_id_last4" is null or "payroll_employer_states"."withholding_id_last4" ~ '^[0-9]{4}$') and ("payroll_employer_states"."unemployment_id_last4" is null or "payroll_employer_states"."unemployment_id_last4" ~ '^[0-9]{4}$'))
);--> statement-breakpoint
ALTER TABLE "payroll_employer_states" ADD CONSTRAINT "payroll_employer_states_employer_id_payroll_employers_id_fk" FOREIGN KEY ("employer_id") REFERENCES "public"."payroll_employers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "legal_entity_id" uuid;--> statement-breakpoint
ALTER TABLE "shops" ADD CONSTRAINT "shops_legal_entity_id_payroll_employers_id_fk" FOREIGN KEY ("legal_entity_id") REFERENCES "public"."payroll_employers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "shops_legal_entity_idx" ON "shops" USING btree ("legal_entity_id");--> statement-breakpoint
ALTER TABLE "tip_payouts" ADD COLUMN "employer_id" uuid;--> statement-breakpoint
ALTER TABLE "tip_payouts" ADD CONSTRAINT "tip_payouts_employer_id_payroll_employers_id_fk" FOREIGN KEY ("employer_id") REFERENCES "public"."payroll_employers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tip_declarations" ADD COLUMN "employer_id" uuid;--> statement-breakpoint
ALTER TABLE "tip_declarations" ADD CONSTRAINT "tip_declarations_employer_id_payroll_employers_id_fk" FOREIGN KEY ("employer_id") REFERENCES "public"."payroll_employers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD COLUMN "employer_id" uuid;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_employer_id_payroll_employers_id_fk" FOREIGN KEY ("employer_id") REFERENCES "public"."payroll_employers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_punches" ADD COLUMN "employer_id" uuid;--> statement-breakpoint
ALTER TABLE "time_punches" ADD CONSTRAINT "time_punches_employer_id_payroll_employers_id_fk" FOREIGN KEY ("employer_id") REFERENCES "public"."payroll_employers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD COLUMN "employer_id" uuid;--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_employer_id_payroll_employers_id_fk" FOREIGN KEY ("employer_id") REFERENCES "public"."payroll_employers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Payouts and declarations take the shop's employer when written and keep it, like tips. Time follows its shop: moved to another shop, it takes that shop's employer.
CREATE TRIGGER "tip_payouts_employer" BEFORE INSERT ON "tip_payouts" FOR EACH ROW EXECUTE FUNCTION "tip_employer"();--> statement-breakpoint
CREATE TRIGGER "tip_declarations_employer" BEFORE INSERT ON "tip_declarations" FOR EACH ROW EXECUTE FUNCTION "tip_employer"();--> statement-breakpoint
CREATE OR REPLACE FUNCTION "time_employer"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'INSERT' AND NEW."employer_id" IS NOT NULL THEN
		RETURN NEW;
	END IF;
	SELECT "employer_id" INTO NEW."employer_id" FROM "pay_groups" WHERE "shop_id" = NEW."shop_id";
	RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "time_entries_employer" BEFORE INSERT OR UPDATE OF "shop_id" ON "time_entries" FOR EACH ROW EXECUTE FUNCTION "time_employer"();--> statement-breakpoint
CREATE TRIGGER "time_punches_employer" BEFORE INSERT OR UPDATE OF "shop_id" ON "time_punches" FOR EACH ROW EXECUTE FUNCTION "time_employer"();--> statement-breakpoint
-- A locked pay period keeps the employer its pay group had at the lock.
CREATE OR REPLACE FUNCTION "payroll_runs_employer"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF NEW."employer_id" IS NULL THEN
		SELECT "employer_id" INTO NEW."employer_id" FROM "pay_groups" WHERE "id" = NEW."pay_group_id";
	END IF;
	RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "payroll_runs_employer" BEFORE INSERT ON "payroll_runs" FOR EACH ROW EXECUTE FUNCTION "payroll_runs_employer"();--> statement-breakpoint
-- Declarations stay append-only; the one change allowed is tagging an untagged row with its employer.
CREATE OR REPLACE FUNCTION "tip_declarations_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'UPDATE' AND OLD."employer_id" IS NULL AND NEW."employer_id" IS NOT NULL AND (to_jsonb(NEW) - 'employer_id') = (to_jsonb(OLD) - 'employer_id') THEN
		RETURN NEW;
	END IF;
	RAISE EXCEPTION 'tip_declarations %: declarations are never changed or removed; add a correction instead', OLD."id";
END $$;--> statement-breakpoint
-- The shop's legal entity is its pay group's employer, kept in step; rows written before the shop had one are tagged once it does, and a tag already set never changes.
CREATE OR REPLACE FUNCTION "pay_groups_tag_tips"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	UPDATE "shops" SET "legal_entity_id" = NEW."employer_id" WHERE "id" = NEW."shop_id" AND "legal_entity_id" IS DISTINCT FROM NEW."employer_id";
	IF NEW."employer_id" IS NOT NULL THEN
		UPDATE "tip_ledger" SET "employer_id" = NEW."employer_id" WHERE "shop_id" = NEW."shop_id" AND "employer_id" IS NULL;
		UPDATE "tip_absorptions" SET "employer_id" = NEW."employer_id" WHERE "shop_id" = NEW."shop_id" AND "employer_id" IS NULL;
		UPDATE "tip_payouts" SET "employer_id" = NEW."employer_id" WHERE "shop_id" = NEW."shop_id" AND "employer_id" IS NULL;
		UPDATE "tip_declarations" SET "employer_id" = NEW."employer_id" WHERE "shop_id" = NEW."shop_id" AND "employer_id" IS NULL;
		UPDATE "time_entries" SET "employer_id" = NEW."employer_id" WHERE "shop_id" = NEW."shop_id" AND "employer_id" IS NULL;
		UPDATE "time_punches" SET "employer_id" = NEW."employer_id" WHERE "shop_id" = NEW."shop_id" AND "employer_id" IS NULL;
		UPDATE "payroll_runs" SET "employer_id" = NEW."employer_id" WHERE "pay_group_id" = NEW."id" AND "employer_id" IS NULL;
	END IF;
	RETURN NULL;
END $$;--> statement-breakpoint
UPDATE "shops" s SET "legal_entity_id" = g."employer_id" FROM "pay_groups" g WHERE g."shop_id" = s."id" AND g."employer_id" IS NOT NULL;--> statement-breakpoint
UPDATE "tip_payouts" t SET "employer_id" = g."employer_id" FROM "pay_groups" g WHERE g."shop_id" = t."shop_id" AND t."employer_id" IS NULL AND g."employer_id" IS NOT NULL;--> statement-breakpoint
UPDATE "tip_declarations" t SET "employer_id" = g."employer_id" FROM "pay_groups" g WHERE g."shop_id" = t."shop_id" AND t."employer_id" IS NULL AND g."employer_id" IS NOT NULL;--> statement-breakpoint
UPDATE "time_entries" t SET "employer_id" = g."employer_id" FROM "pay_groups" g WHERE g."shop_id" = t."shop_id" AND t."employer_id" IS NULL AND g."employer_id" IS NOT NULL;--> statement-breakpoint
UPDATE "time_punches" t SET "employer_id" = g."employer_id" FROM "pay_groups" g WHERE g."shop_id" = t."shop_id" AND t."employer_id" IS NULL AND g."employer_id" IS NOT NULL;--> statement-breakpoint
UPDATE "payroll_runs" r SET "employer_id" = g."employer_id" FROM "pay_groups" g WHERE g."id" = r."pay_group_id" AND r."employer_id" IS NULL AND g."employer_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "tip_payouts_employer_idx" ON "tip_payouts" USING btree ("employer_id","created_at");--> statement-breakpoint
CREATE INDEX "time_entries_employer_idx" ON "time_entries" USING btree ("employer_id","starts_at");
