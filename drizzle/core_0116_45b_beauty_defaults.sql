-- ST-C13: 45B covers barbering for tax years after Dec 31, 2024, at the $7.25 federal minimum wage (2025 Form 8846).
-- A brand that saved the old defaults (2026-01-01, $5.15) gets the corrected ones; any other value it chose stays.
UPDATE "brand_settings" SET "payroll" = jsonb_set("payroll", '{tipTax,creditFrom}', '"2025-01-01"') WHERE "payroll" #>> '{tipTax,creditFrom}' = '2026-01-01';--> statement-breakpoint
UPDATE "brand_settings" SET "payroll" = jsonb_set("payroll", '{tipTax,creditWageCentsPerHour}', '725') WHERE "payroll" #>> '{tipTax,creditWageCentsPerHour}' = '515';
