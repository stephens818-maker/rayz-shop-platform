-- ST-I10: an employee's pay question, answered by their managers and escalated to the owners.
CREATE TABLE IF NOT EXISTS "pay_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"staff_id" uuid NOT NULL,
	"shop_id" uuid NOT NULL,
	"period_start" date,
	"topic" text NOT NULL,
	"detail" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"level" text DEFAULT 'manager' NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"escalated_at" timestamp with time zone,
	"reminded_at" timestamp with time zone,
	"history" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pay_questions_status_ck" CHECK ("status" in ('open', 'answered', 'resolved')),
	CONSTRAINT "pay_questions_level_ck" CHECK ("level" in ('manager', 'owner'))
);--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "pay_questions" ADD CONSTRAINT "pay_questions_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "pay_questions" ADD CONSTRAINT "pay_questions_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pay_questions_staff_idx" ON "pay_questions" USING btree ("staff_id", "created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pay_questions_open_idx" ON "pay_questions" USING btree ("shop_id", "status", "due_at");
