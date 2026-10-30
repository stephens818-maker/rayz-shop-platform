-- Substring search on client name, phone, and email (the front desk types "smi", "7001", "gmail").
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customers_name_trgm" ON "customers" USING gin ((lower("first_name" || ' ' || coalesce("last_name", ''))) gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customers_phone_trgm" ON "customers" USING gin ("phone" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customers_email_trgm" ON "customers" USING gin ((lower("email")) gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "appointments_customer_shop_idx" ON "appointments" ("customer_id", "shop_id");
