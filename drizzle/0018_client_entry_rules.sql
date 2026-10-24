-- Entering a client detail is set apart from seeing it: a rule is now for view (hidden, masked, full), add or edit (allow, deny).
ALTER TABLE "client_field_rules" DROP CONSTRAINT "client_field_rules_uq";--> statement-breakpoint
ALTER TABLE "client_field_rules" DROP CONSTRAINT "client_field_rules_level_valid";--> statement-breakpoint
ALTER TABLE "client_field_rules" ADD COLUMN "setting" text DEFAULT 'view' NOT NULL;--> statement-breakpoint
ALTER TABLE "client_field_rules" ADD CONSTRAINT "client_field_rules_uq" UNIQUE NULLS NOT DISTINCT("field","setting","role_id","staff_id","shop_id");--> statement-breakpoint
ALTER TABLE "client_field_rules" ADD CONSTRAINT "client_field_rules_value" CHECK (("setting" = 'view' AND "level" IN ('hidden', 'masked', 'full')) OR ("setting" IN ('add', 'edit') AND "level" IN ('allow', 'deny') AND "field" <> 'ratings'));
