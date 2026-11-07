-- Sign-in restrictions: each location can limit staff sign-in to its network (allowed IPs and CIDR ranges), to approved devices, or both; people with "Can access remotely" are exempt.
ALTER TABLE "shops" ADD COLUMN "network_access" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "brand_settings" ADD COLUMN "network_access" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
CREATE TABLE "trusted_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"label" text NOT NULL,
	"token_hash" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"requested_by" uuid,
	"requested_ip" text,
	"user_agent" text,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"last_ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trusted_devices_status" CHECK ("trusted_devices"."status" in ('pending', 'approved', 'declined', 'revoked'))
);--> statement-breakpoint
ALTER TABLE "trusted_devices" ADD CONSTRAINT "trusted_devices_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trusted_devices" ADD CONSTRAINT "trusted_devices_requested_by_staff_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."staff"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trusted_devices" ADD CONSTRAINT "trusted_devices_decided_by_staff_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."staff"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "trusted_devices_token_shop_uq" ON "trusted_devices" USING btree ("token_hash","shop_id");--> statement-breakpoint
CREATE INDEX "trusted_devices_shop_idx" ON "trusted_devices" USING btree ("shop_id","status");--> statement-breakpoint
CREATE INDEX "audit_network_at_idx" ON "audit_log" USING btree ("at") WHERE "audit_log"."action" like 'network.%';--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" || '["access.remote","devices.approve","network.settings"]'::jsonb WHERE "key" = 'brand_admin' AND NOT ("permissions" ? 'network.settings');--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" || '["devices.approve"]'::jsonb WHERE "key" IN ('regional_manager', 'shop_manager') AND NOT ("permissions" ? 'devices.approve');
