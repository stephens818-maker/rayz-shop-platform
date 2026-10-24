-- Time clock events write real block-outs: a break, a clock-out before the scheduled end and (if the shop turns it on) "Not in yet" become time_blocks rows linked to their punches. A manager's release is remembered so the clock doesn't put the block back.
ALTER TABLE "time_blocks" ADD COLUMN "source" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "time_blocks" ADD COLUMN "clock_key" text;--> statement-breakpoint
ALTER TABLE "time_blocks" ADD COLUMN "punch_id" uuid;--> statement-breakpoint
ALTER TABLE "time_blocks" ADD COLUMN "end_punch_id" uuid;--> statement-breakpoint
ALTER TABLE "time_blocks" ADD COLUMN "clock_open" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "time_blocks" ADD COLUMN "overridden_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "time_blocks" ADD COLUMN "overridden_by" uuid;--> statement-breakpoint
ALTER TABLE "time_blocks" ADD CONSTRAINT "time_blocks_punch_id_time_punches_id_fk" FOREIGN KEY ("punch_id") REFERENCES "public"."time_punches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_blocks" ADD CONSTRAINT "time_blocks_end_punch_id_time_punches_id_fk" FOREIGN KEY ("end_punch_id") REFERENCES "public"."time_punches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_blocks" ADD CONSTRAINT "time_blocks_source" CHECK ("time_blocks"."source" in ('manual', 'clock'));--> statement-breakpoint
CREATE UNIQUE INDEX "time_blocks_clock_key_unique" ON "time_blocks" USING btree ("clock_key");--> statement-breakpoint
CREATE INDEX "time_blocks_punch_idx" ON "time_blocks" USING btree ("punch_id");--> statement-breakpoint
CREATE INDEX "time_blocks_clock_open_idx" ON "time_blocks" USING btree ("ends_at") WHERE "time_blocks"."clock_open";--> statement-breakpoint
ALTER TABLE "time_punches" ADD COLUMN "reason_id" uuid;--> statement-breakpoint
ALTER TABLE "time_punches" ADD COLUMN "planned_min" integer;--> statement-breakpoint
ALTER TABLE "time_punches" ADD CONSTRAINT "time_punches_reason_id_block_reasons_id_fk" FOREIGN KEY ("reason_id") REFERENCES "public"."block_reasons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE TABLE "clock_block_releases" (
	"clock_key" text PRIMARY KEY NOT NULL,
	"staff_id" uuid NOT NULL,
	"shop_id" uuid,
	"released_by" uuid,
	"released_at" timestamp with time zone DEFAULT now() NOT NULL,
	"note" text
);--> statement-breakpoint
ALTER TABLE "clock_block_releases" ADD CONSTRAINT "clock_block_releases_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clock_block_releases" ADD CONSTRAINT "clock_block_releases_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
INSERT INTO "block_reasons" ("key", "label", "color", "used_for", "counts_as_lunch", "notice_exempt", "private", "sort_order") VALUES
	('clocked_out', 'Clocked out', '#334155', 'clock', false, false, false, 200),
	('not_in', 'Not in yet', '#eab308', 'clock', false, false, false, 210)
ON CONFLICT DO NOTHING;
