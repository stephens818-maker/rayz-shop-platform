-- The calendar follows the time clock: a barber can let an early clock-in open earlier slots; clock alerts emailed to managers are logged so each goes out once.
ALTER TABLE "staff" ADD COLUMN "clock_opens_early" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE TABLE "clock_alert_log" (
	"key" text PRIMARY KEY NOT NULL,
	"shop_id" uuid NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "clock_alert_log" ADD CONSTRAINT "clock_alert_log_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;
