-- Rowan and Harper were placeholders added by core_0167. Only real staff belong at Dubuque.
-- These two staff codes are the ones that migration inserted. Anyone else is left alone.
DELETE FROM "staff_schedules"
WHERE "staff_id" IN (SELECT "id" FROM "staff" WHERE "staff_code" IN ('S-DUB-ROWAN', 'S-DUB-HARPER'));--> statement-breakpoint
DELETE FROM "staff_shops"
WHERE "staff_id" IN (SELECT "id" FROM "staff" WHERE "staff_code" IN ('S-DUB-ROWAN', 'S-DUB-HARPER'));--> statement-breakpoint
DO $$
BEGIN
  DELETE FROM "staff" WHERE "staff_code" IN ('S-DUB-ROWAN', 'S-DUB-HARPER');
EXCEPTION
  WHEN foreign_key_violation THEN
    UPDATE "staff"
    SET "active" = false, "is_bookable" = false
    WHERE "staff_code" IN ('S-DUB-ROWAN', 'S-DUB-HARPER');
END $$;
