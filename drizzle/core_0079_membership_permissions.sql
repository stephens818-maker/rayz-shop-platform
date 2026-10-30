-- Memberships permissions on the role templates: brand admins run plans and sell; managers sell, cancel, and keep members at their shops. Additive only.
UPDATE "roles" SET "permissions" = "permissions" || '["memberships.manage"]'::jsonb WHERE "key" IN ('brand_admin') AND NOT ("permissions" ? 'memberships.manage');--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" || '["memberships.sell"]'::jsonb WHERE "key" IN ('brand_admin', 'franchisee_owner', 'franchisee_manager', 'regional_manager', 'shop_manager') AND NOT ("permissions" ? 'memberships.sell');
