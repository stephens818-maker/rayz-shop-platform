CREATE TABLE "block_reasons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"color" text NOT NULL,
	"used_for" text DEFAULT 'both' NOT NULL,
	"counts_as_lunch" boolean DEFAULT false NOT NULL,
	"notice_exempt" boolean DEFAULT false NOT NULL,
	"private" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 100 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "block_reasons_key_unique" UNIQUE("key")
);
--> statement-breakpoint
ALTER TABLE "time_block_series" ADD COLUMN "reason_id" uuid;--> statement-breakpoint
ALTER TABLE "time_block_series" ADD COLUMN "note" text;--> statement-breakpoint
ALTER TABLE "time_blocks" ADD COLUMN "reason_id" uuid;--> statement-breakpoint
ALTER TABLE "time_blocks" ADD COLUMN "note" text;--> statement-breakpoint
ALTER TABLE "time_off_requests" ADD COLUMN "reason_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "block_reasons_label_unique" ON "block_reasons" USING btree (lower("label")) WHERE "block_reasons"."archived_at" IS NULL;--> statement-breakpoint
ALTER TABLE "time_block_series" ADD CONSTRAINT "time_block_series_reason_id_block_reasons_id_fk" FOREIGN KEY ("reason_id") REFERENCES "public"."block_reasons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_blocks" ADD CONSTRAINT "time_blocks_reason_id_block_reasons_id_fk" FOREIGN KEY ("reason_id") REFERENCES "public"."block_reasons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_off_requests" ADD CONSTRAINT "time_off_requests_reason_id_block_reasons_id_fk" FOREIGN KEY ("reason_id") REFERENCES "public"."block_reasons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
INSERT INTO "block_reasons" ("key", "label", "color", "used_for", "counts_as_lunch", "notice_exempt", "private", "sort_order") VALUES
	('lunch', 'Lunch', '#f59e0b', 'blocks', true, false, false, 10),
	('break', 'Break', '#14b8a6', 'blocks', false, false, false, 20),
	('bank', 'Bank', '#6366f1', 'blocks', false, false, false, 30),
	('doctor', 'Doctor', '#ef4444', 'both', false, false, true, 40),
	('personal', 'Personal', '#8b5cf6', 'both', false, false, false, 50),
	('vacation', 'Vacation', '#0ea5e9', 'time_off', false, false, false, 60),
	('sick', 'Sick', '#f43f5e', 'both', false, true, true, 70),
	('training', 'Training', '#22c55e', 'both', false, false, false, 80),
	('meeting', 'Meeting', '#64748b', 'blocks', false, false, false, 90)
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
UPDATE "time_off_requests" t SET "reason_id" = r."id", "reason" = r."label" FROM "block_reasons" r WHERE r."key" = t."reason";--> statement-breakpoint
UPDATE "time_off_requests" SET "reason" = initcap("reason") WHERE "reason_id" IS NULL;--> statement-breakpoint
UPDATE "time_blocks" b SET "reason_id" = q."reason_id", "reason" = q."reason", "note" = q."note" FROM "time_off_requests" q WHERE b."request_id" = q."id";--> statement-breakpoint
UPDATE "time_blocks" b SET "reason_id" = r."id",
	"note" = CASE WHEN lower(b."reason") IN (lower(r."label"), 'blocked', '') THEN NULL ELSE b."reason" END,
	"reason" = r."label"
	FROM "block_reasons" r WHERE b."request_id" IS NULL AND b."category" IN ('lunch', 'break', 'personal') AND r."key" = b."category";--> statement-breakpoint
UPDATE "time_blocks" b SET "reason_id" = r."id", "reason" = r."label" FROM "block_reasons" r WHERE b."reason_id" IS NULL AND b."request_id" IS NULL AND lower(trim(b."reason")) = lower(r."label");--> statement-breakpoint
UPDATE "time_block_series" s SET "reason_id" = r."id",
	"note" = CASE WHEN lower(s."reason") IN (lower(r."label"), 'blocked', '') THEN NULL ELSE s."reason" END,
	"reason" = r."label"
	FROM "block_reasons" r WHERE s."category" IN ('lunch', 'break', 'personal') AND r."key" = s."category";--> statement-breakpoint
UPDATE "time_block_series" s SET "reason_id" = r."id", "reason" = r."label" FROM "block_reasons" r WHERE s."reason_id" IS NULL AND lower(trim(s."reason")) = lower(r."label");--> statement-breakpoint
UPDATE "time_blocks" SET "category" = 'other' WHERE "category" IN ('break', 'personal');--> statement-breakpoint
UPDATE "time_block_series" SET "category" = 'other' WHERE "category" IN ('break', 'personal');--> statement-breakpoint
UPDATE "time_blocks" b SET "category" = 'lunch' FROM "block_reasons" r WHERE b."reason_id" = r."id" AND r."counts_as_lunch" AND b."category" = 'other';--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" || '["blocks.private","blocks.reasons"]'::jsonb WHERE "key" IN ('brand_admin', 'regional_manager', 'shop_manager') AND NOT ("permissions" ? 'blocks.private');--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" || '["blocks.private"]'::jsonb WHERE "key" IS NULL AND "permissions" ? 'timeoff.approve' AND NOT ("permissions" ? 'blocks.private');--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" || '["blocks.reasons"]'::jsonb WHERE "key" IS NULL AND "permissions" ? 'settings.shop' AND NOT ("permissions" ? 'blocks.reasons');
