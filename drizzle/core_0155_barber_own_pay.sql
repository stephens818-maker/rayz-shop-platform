-- Own pay (hourly gross, commission, tips) for barbers and the managers who hire them. A shop login never keeps it.
UPDATE "roles" SET "permissions" = "permissions" || '["compensation.own"]'::jsonb WHERE "key" IN ('barber', 'apprentice', 'shop_manager', 'regional_manager', 'franchisee_manager', 'franchisee_owner') AND NOT ("permissions" ? 'compensation.own');
