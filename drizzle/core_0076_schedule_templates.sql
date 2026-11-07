-- Schedule templates: a named week of shifts applied to many barbers at once (bulk edit).
CREATE TABLE "schedule_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"rows" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" uuid REFERENCES "staff"("id") ON DELETE SET NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "schedule_templates_rows_array" CHECK (jsonb_typeof("rows") = 'array')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "schedule_templates_name_uq" ON "schedule_templates" (lower("name"));
