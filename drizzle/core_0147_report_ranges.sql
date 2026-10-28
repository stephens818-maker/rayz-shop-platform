-- Date range picker (Charles, Oct 28): each person's last date range on each report, the dashboard and the Payroll Report, so a report opened without dates opens on the range they picked last. A preset id or custom from/to dates (America/Chicago calendar days). Additive only.
CREATE TABLE IF NOT EXISTS "staff_report_ranges" (
	"staff_id" uuid NOT NULL REFERENCES "staff"("id") ON DELETE cascade,
	"report" text NOT NULL,
	"preset" text,
	"from_date" date,
	"to_date" date,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_report_ranges_staff_id_report_pk" PRIMARY KEY ("staff_id", "report"),
	CONSTRAINT "staff_report_ranges_report" CHECK (length("report") between 1 and 40),
	CONSTRAINT "staff_report_ranges_range" CHECK (("preset" is not null and length("preset") <= 80) or ("from_date" is not null and "to_date" is not null and "from_date" <= "to_date"))
);
