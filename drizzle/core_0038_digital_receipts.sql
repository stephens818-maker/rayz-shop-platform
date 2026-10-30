-- Digital receipts: every receipt texted or emailed for a ticket (each with its own link to the receipt page; only the token's SHA-256 is kept), the client's "no receipt" choice, and emails that turned receipt emails off.
CREATE TABLE "receipt_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sale_id" uuid NOT NULL,
	"shop_id" uuid NOT NULL,
	"customer_id" uuid,
	"channel" text NOT NULL,
	"destination" text,
	"masked" text,
	"purpose" text NOT NULL,
	"token_hash" text,
	"job_id" uuid,
	"skipped" text,
	"sent_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "receipt_deliveries_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "receipt_deliveries_channel" CHECK ("receipt_deliveries"."channel" in ('sms', 'email', 'none')),
	CONSTRAINT "receipt_deliveries_purpose" CHECK ("receipt_deliveries"."purpose" in ('counter', 'handoff', 'refund', 'void', 'resend', 'request')),
	CONSTRAINT "receipt_deliveries_skipped" CHECK ("receipt_deliveries"."skipped" is null or "receipt_deliveries"."skipped" in ('opted_out', 'no_consent')),
	CONSTRAINT "receipt_deliveries_destination" CHECK (("receipt_deliveries"."channel" = 'none') = ("receipt_deliveries"."destination" is null))
);--> statement-breakpoint
ALTER TABLE "receipt_deliveries" ADD CONSTRAINT "receipt_deliveries_sale_id_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "public"."sales"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_deliveries" ADD CONSTRAINT "receipt_deliveries_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_deliveries" ADD CONSTRAINT "receipt_deliveries_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_deliveries" ADD CONSTRAINT "receipt_deliveries_job_id_notification_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."notification_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_deliveries" ADD CONSTRAINT "receipt_deliveries_sent_by_staff_id_fk" FOREIGN KEY ("sent_by") REFERENCES "public"."staff"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "receipt_deliveries_sale_idx" ON "receipt_deliveries" USING btree ("sale_id","created_at");--> statement-breakpoint
CREATE INDEX "receipt_deliveries_destination_idx" ON "receipt_deliveries" USING btree ("destination","created_at");--> statement-breakpoint
CREATE TABLE "receipt_opt_outs" (
	"email" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
