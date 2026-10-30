-- Brand-level roles, part two: reports for every shop (not just the person's own), dollar amounts in
-- reports as their own permission, App config split from brand-level settings, the Apprentice
-- template, and Bookkeeper renamed Bookkeeper / Accountant. Everyone who saw dollar amounts in
-- reports still does; App config stays the Brand Owner's until they give it.
UPDATE "roles" SET "permissions" = "permissions" || '["reports.money"]'::jsonb WHERE "key" IN ('brand_admin', 'franchisee_owner', 'franchisee_manager', 'regional_manager', 'shop_manager', 'front_desk', 'shop_login', 'barber', 'bookkeeper', 'marketing') AND NOT "permissions" ? 'reports.money';--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" || '["reports.money"]'::jsonb WHERE "key" IS NULL AND NOT "permissions" ? 'reports.money';--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" || '["reports.all_shops"]'::jsonb WHERE "key" IN ('brand_admin', 'bookkeeper') AND NOT "permissions" ? 'reports.all_shops';--> statement-breakpoint
-- The same for a shop's own version of a role.
UPDATE "shop_sync_state" st SET "local" = jsonb_set(st."local", '{permissions}', (st."local"->'permissions') || '["reports.money"]'::jsonb)
  FROM "roles" r WHERE st."key" = 'role:' || r."id"::text AND r."key" IS DISTINCT FROM 'brand_owner'
  AND jsonb_typeof(st."local"->'permissions') = 'array' AND NOT st."local"->'permissions' ? 'reports.money';--> statement-breakpoint
UPDATE "shop_sync_state" st SET "local" = jsonb_set(st."local", '{permissions}', (st."local"->'permissions') || '["reports.all_shops"]'::jsonb)
  FROM "roles" r WHERE st."key" = 'role:' || r."id"::text AND r."key" IN ('brand_admin', 'bookkeeper')
  AND jsonb_typeof(st."local"->'permissions') = 'array' AND NOT st."local"->'permissions' ? 'reports.all_shops';--> statement-breakpoint
-- Custom roles already called what a template is about to be called keep working under a new name.
UPDATE "roles" SET "name" = "name" || ' (custom)', "updated_at" = now()
  WHERE lower("name") IN ('apprentice', 'bookkeeper / accountant') AND "key" IS DISTINCT FROM 'apprentice' AND "key" IS DISTINCT FROM 'bookkeeper';--> statement-breakpoint
UPDATE "roles" SET "name" = 'Bookkeeper / Accountant' WHERE "key" = 'bookkeeper' AND "name" = 'Bookkeeper';--> statement-breakpoint
UPDATE "roles" SET "description" = 'Read-only books for every shop: sales, tax, card fees, P&L by Stripe account and payouts, payroll and tip reports, and the payroll and QuickBooks downloads. Sees tickets and pay rates but no client contact details, and can''t check out, refund, edit anything or change settings.' WHERE "key" = 'bookkeeper' AND "description" = 'Keeps the books: sales, tax, card fees, P&L by Stripe account and payouts, payroll and tip reports, and the payroll and QuickBooks downloads. Sees tickets but no client contact details, and can''t check out, refund or change settings.';--> statement-breakpoint
UPDATE "roles" SET "sort_order" = 110 WHERE "key" = 'bookkeeper';--> statement-breakpoint
UPDATE "roles" SET "sort_order" = 120 WHERE "key" = 'marketing';--> statement-breakpoint
INSERT INTO "roles" ("key", "name", "description", "permissions", "max_discount_pct", "default_scope", "sort_order")
SELECT 'apprentice', 'Apprentice',
	'Learning the trade: their own column and clients at menu prices, client notes to read, the time clock, their own timesheet and tips. No discounts, refunds or blocking time, and their own reports show counts and times but no dollar amounts.',
	'["notes.view","timeoff.request","timeclock.punch","timesheet.own","tips.own","report.my_sales.view","report.service_times.view"]'::jsonb,
	0, 'one', 100
WHERE NOT EXISTS (SELECT 1 FROM "roles" WHERE "key" = 'apprentice');
