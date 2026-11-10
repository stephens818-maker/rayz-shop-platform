-- Pay groups are made on a shop's first payroll use, so tips can be written before their shop has an employer. Once it has one, the shop's untagged tips and absorbed tips get it; a tag already set never changes.
CREATE OR REPLACE FUNCTION "tip_absorptions_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'UPDATE' AND OLD."employer_id" IS NULL AND NEW."employer_id" IS NOT NULL AND (to_jsonb(NEW) - 'employer_id') = (to_jsonb(OLD) - 'employer_id') THEN
		RETURN NEW;
	END IF;
	RAISE EXCEPTION 'tip_absorptions %: absorbed tips are never changed or removed', OLD."id";
END $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "pay_groups_tag_tips"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF NEW."employer_id" IS NOT NULL THEN
		UPDATE "tip_ledger" SET "employer_id" = NEW."employer_id" WHERE "shop_id" = NEW."shop_id" AND "employer_id" IS NULL;
		UPDATE "tip_absorptions" SET "employer_id" = NEW."employer_id" WHERE "shop_id" = NEW."shop_id" AND "employer_id" IS NULL;
	END IF;
	RETURN NULL;
END $$;--> statement-breakpoint
CREATE TRIGGER "pay_groups_tag_tips" AFTER INSERT OR UPDATE OF "legal_entity", "employer_id" ON "pay_groups" FOR EACH ROW EXECUTE FUNCTION "pay_groups_tag_tips"();--> statement-breakpoint
UPDATE "tip_ledger" l SET "employer_id" = g."employer_id" FROM "pay_groups" g WHERE g."shop_id" = l."shop_id" AND l."employer_id" IS NULL AND g."employer_id" IS NOT NULL;--> statement-breakpoint
UPDATE "tip_absorptions" a SET "employer_id" = g."employer_id" FROM "pay_groups" g WHERE g."shop_id" = a."shop_id" AND a."employer_id" IS NULL AND g."employer_id" IS NOT NULL;
