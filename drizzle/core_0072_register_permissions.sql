-- Two register permissions from the per-staff permission matrix: opening the drawer with no sale goes to every role that runs the drawer, and custom charges to every role that can change menu prices. No schema change.
UPDATE "roles" SET "permissions" = "permissions" || '["drawer.no_sale"]'::jsonb WHERE "permissions" ? 'drawer.manage' AND NOT ("permissions" ? 'drawer.no_sale');--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" || '["pos.custom_charge"]'::jsonb WHERE "permissions" ? 'pos.price_override' AND NOT ("permissions" ? 'pos.custom_charge');
