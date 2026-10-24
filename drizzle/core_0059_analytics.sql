-- The event log: one append-only row for every meaningful thing that happens (bookings and their funnel, appointment flow, tickets and payments, retail stock, staff clock and block-outs, messages and campaigns, client badges, reviews, the assistant, phone calls, walk-ins, post-visit satisfaction). Rows are written by triggers on the tables the app already keeps, so every write path is covered (staff screens, the customer app's API, imports, crons), plus the booking funnel the app reports itself. Each row has when, the business day, the location, who did it (staff, client or system), the channel and device, the entity ids and a few measures, so any metric can be worked out later from history. Ids, numbers and short codes only: never a name, phone, email, address, message body, card or bank detail. Additive only.
CREATE TABLE IF NOT EXISTS "analytics_events" (
	"id" bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	"occurred_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"business_date" date NOT NULL,
	"event" text NOT NULL,
	"category" text NOT NULL,
	"shop_id" uuid,
	"actor_kind" text NOT NULL,
	"actor_staff_id" uuid,
	"staff_id" uuid,
	"customer_id" uuid,
	"channel" text,
	"device" text,
	"source" text,
	"entity" text NOT NULL,
	"entity_id" text,
	"appointment_id" uuid,
	"sale_id" uuid,
	"amount_cents" bigint,
	"quantity" integer,
	"minutes" double precision,
	"value" double precision,
	"subtype" text,
	"reason" text,
	"props" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"dedupe_key" text,
	CONSTRAINT "analytics_events_event" CHECK ("event" ~ '^[a-z_]+\.[a-z_]+$' AND "category" = split_part("event", '.', 1)),
	CONSTRAINT "analytics_events_actor_kind" CHECK ("actor_kind" IN ('staff', 'client', 'system')),
	CONSTRAINT "analytics_events_lengths" CHECK (char_length(coalesce("subtype", '')) <= 60 AND char_length(coalesce("reason", '')) <= 200 AND char_length(coalesce("source", '')) <= 60 AND char_length(coalesce("channel", '')) <= 30 AND char_length(coalesce("device", '')) <= 30),
	CONSTRAINT "analytics_events_props" CHECK (jsonb_typeof("props") = 'object'),
	CONSTRAINT "analytics_events_dedupe_key" UNIQUE ("dedupe_key")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "analytics_events_day_idx" ON "analytics_events" USING btree ("business_date", "event");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "analytics_events_shop_idx" ON "analytics_events" USING btree ("shop_id", "business_date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "analytics_events_staff_idx" ON "analytics_events" USING btree ("staff_id", "business_date") WHERE "staff_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "analytics_events_customer_idx" ON "analytics_events" USING btree ("customer_id") WHERE "customer_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "analytics_events_entity_idx" ON "analytics_events" USING btree ("entity", "entity_id");--> statement-breakpoint
-- History is never rewritten. The one change allowed is the client: moved to the kept record when two are merged, or cleared when a client is erased.
CREATE OR REPLACE FUNCTION "analytics_events_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'UPDATE' AND (to_jsonb(NEW) - 'customer_id') = (to_jsonb(OLD) - 'customer_id') THEN RETURN NEW; END IF;
	RAISE EXCEPTION 'The event log is append-only' USING ERRCODE = 'check_violation';
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "analytics_events_append_only" ON "analytics_events";--> statement-breakpoint
CREATE TRIGGER "analytics_events_append_only" BEFORE UPDATE OR DELETE ON "analytics_events" FOR EACH ROW EXECUTE FUNCTION "analytics_events_guard"();--> statement-breakpoint
DROP TRIGGER IF EXISTS "analytics_events_scrub_sensitive" ON "analytics_events";--> statement-breakpoint
CREATE TRIGGER "analytics_events_scrub_sensitive" BEFORE INSERT ON "analytics_events" FOR EACH ROW WHEN (NEW."reason" IS NOT NULL) EXECUTE FUNCTION "scrub_sensitive_row"('reason');--> statement-breakpoint
ALTER TABLE "brand_settings" ADD COLUMN IF NOT EXISTS "analytics" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN IF NOT EXISTS "cancel_reason" text;--> statement-breakpoint
ALTER TABLE "appointments" DROP CONSTRAINT IF EXISTS "appointments_cancel_reason_len";--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_cancel_reason_len" CHECK ("cancel_reason" IS NULL OR char_length("cancel_reason") <= 200);--> statement-breakpoint
DROP TRIGGER IF EXISTS "appointments_cancel_scrub_sensitive" ON "appointments";--> statement-breakpoint
CREATE TRIGGER "appointments_cancel_scrub_sensitive" BEFORE INSERT OR UPDATE OF "cancel_reason" ON "appointments" FOR EACH ROW EXECUTE FUNCTION "scrub_sensitive_row"('cancel_reason');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "call_logs_customer_idx" ON "call_logs" USING btree ("customer_id", "created_at") WHERE "customer_id" IS NOT NULL;--> statement-breakpoint
-- The optional 1-5 after a visit, asked on the receipt (or in the app) to every client alike: it never decides who is sent to Google.
CREATE TABLE IF NOT EXISTS "visit_satisfaction" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sale_id" uuid NOT NULL REFERENCES "sales"("id") ON DELETE cascade,
	"shop_id" uuid NOT NULL REFERENCES "shops"("id") ON DELETE cascade,
	"staff_id" uuid REFERENCES "staff"("id") ON DELETE set null,
	"customer_id" uuid REFERENCES "customers"("id") ON DELETE set null,
	"stars" smallint NOT NULL,
	"channel" text DEFAULT 'receipt' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "visit_satisfaction_stars" CHECK ("stars" BETWEEN 1 AND 5),
	CONSTRAINT "visit_satisfaction_channel" CHECK ("channel" IN ('receipt', 'app')),
	CONSTRAINT "visit_satisfaction_sale_uq" UNIQUE ("sale_id")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "visit_satisfaction_shop_idx" ON "visit_satisfaction" USING btree ("shop_id", "created_at");--> statement-breakpoint
-- Each nightly copy of new events to the brand's warehouse: the id range sent and how it went. The warehouse address is an environment secret, never kept here.
CREATE TABLE IF NOT EXISTS "analytics_exports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target" text NOT NULL,
	"from_id" bigint NOT NULL,
	"to_id" bigint NOT NULL,
	"rows" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"failure" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "analytics_exports_status" CHECK ("status" IN ('running', 'done', 'failed')),
	CONSTRAINT "analytics_exports_failure" CHECK ("failure" IS NULL OR char_length("failure") <= 300)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "analytics_exports_started_idx" ON "analytics_exports" USING btree ("target", "started_at" DESC);--> statement-breakpoint
CREATE OR REPLACE FUNCTION "analytics_minutes"(a timestamptz, b timestamptz) RETURNS double precision LANGUAGE sql IMMUTABLE AS $$
	SELECT extract(epoch FROM b - a) / 60.0
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "analytics_epoch"(t timestamptz) RETURNS text LANGUAGE sql IMMUTABLE AS $$
	SELECT floor(extract(epoch FROM t) * 1000)::bigint::text
$$;--> statement-breakpoint
-- A block-out reason marked private (a medical day, say) is logged without its label.
CREATE OR REPLACE FUNCTION "analytics_private_reason"(r uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
	SELECT coalesce((SELECT "private" FROM "block_reasons" WHERE "id" = r), false)
$$;--> statement-breakpoint
-- How a client found us is short free text ("Instagram"). Anything that looks like contact details is logged as Other.
CREATE OR REPLACE FUNCTION "analytics_safe_source"(t text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
	SELECT CASE
		WHEN t IS NULL OR btrim(t) = '' THEN NULL
		WHEN t ~ '@' OR t ~ '[0-9][0-9 ().-]{5,}[0-9]' OR t ~* '(https?://|www\.)' THEN 'Other'
		ELSE left(btrim("scrub_sensitive_text"(t)), 60)
	END
$$;--> statement-breakpoint
-- Writes one event. Keys: event, at, key (dedupe), shop, staff, customer, actor, actor_kind, channel, device, source, entity, entity_id, appointment, sale, amount, quantity, minutes, value, subtype, reason, props, backfill. The signed-in staff member, device and channel come from the transaction's rayz.event_ctx when the row doesn't say.
CREATE OR REPLACE FUNCTION "analytics_emit"(e jsonb) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
	backfilled boolean := coalesce((e->>'backfill')::boolean, false);
	raw text := current_setting('rayz.event_ctx', true);
	ctx jsonb;
	at timestamptz := coalesce((e->>'at')::timestamptz, clock_timestamp());
	shop uuid := (e->>'shop')::uuid;
	actor uuid := (e->>'actor')::uuid;
	kind text := e->>'actor_kind';
	props jsonb := CASE WHEN jsonb_typeof(e->'props') = 'object' THEN jsonb_strip_nulls(e->'props') ELSE '{}'::jsonb END;
	tz text;
BEGIN
	IF raw IS NOT NULL AND raw <> '' AND NOT backfilled THEN ctx := raw::jsonb; END IF;
	IF actor IS NULL AND coalesce(kind, 'staff') = 'staff' THEN actor := (ctx->>'staff')::uuid; END IF;
	kind := coalesce(kind, CASE WHEN actor IS NOT NULL THEN 'staff' END, ctx->>'kind', 'system');
	IF backfilled THEN props := props || '{"backfilled": true}'::jsonb; END IF;
	IF shop IS NOT NULL THEN SELECT "timezone" INTO tz FROM "shops" WHERE "id" = shop; END IF;
	INSERT INTO "analytics_events" (
		"occurred_at", "business_date", "event", "category", "shop_id", "actor_kind", "actor_staff_id", "staff_id", "customer_id", "channel", "device", "source",
		"entity", "entity_id", "appointment_id", "sale_id", "amount_cents", "quantity", "minutes", "value", "subtype", "reason", "props", "dedupe_key"
	) VALUES (
		at, (at AT TIME ZONE coalesce(tz, 'America/Chicago'))::date, e->>'event', split_part(e->>'event', '.', 1), shop, kind, actor,
		(e->>'staff')::uuid, (e->>'customer')::uuid, left(coalesce(e->>'channel', ctx->>'channel'), 30), left(coalesce(e->>'device', ctx->>'device'), 30), left(e->>'source', 60),
		coalesce(e->>'entity', split_part(e->>'event', '.', 1)), e->>'entity_id', (e->>'appointment')::uuid, (e->>'sale')::uuid,
		round((e->>'amount')::numeric)::bigint, round((e->>'quantity')::numeric)::int, round((e->>'minutes')::numeric, 2)::float8, round((e->>'value')::numeric, 4)::float8,
		left(e->>'subtype', 60), left(nullif(btrim(e->>'reason'), ''), 200), props, e->>'key'
	) ON CONFLICT ("dedupe_key") DO NOTHING;
END $$;--> statement-breakpoint
-- One function per source table turns a row change into the events it implies. n is the row now (null when deleted), o the row before (null when inserted or backfilled). Every event has a fixed dedupe key, so a backfill over rows already logged adds nothing.
CREATE OR REPLACE FUNCTION "analytics_capture"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	EXECUTE format('SELECT %I($1, $2, false)', 'analytics_' || TG_TABLE_NAME) USING NEW, OLD;
	RETURN NULL;
END $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "analytics_appointments"(n "appointments", o "appointments", backfill boolean) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
	base jsonb;
	ch text;
	who text;
	call_id uuid;
	send record;
	cutoff integer;
	lead double precision;
	at timestamptz;
	days integer;
BEGIN
	IF n.id IS NULL THEN RETURN 0; END IF;
	base := jsonb_build_object('shop', n.shop_id, 'staff', n.staff_id, 'customer', n.customer_id, 'source', n.source, 'entity', 'appointment', 'entity_id', n.id, 'appointment', n.id, 'backfill', backfill);
	IF o IS NULL THEN
		ch := CASE n.source WHEN 'online' THEN 'online' WHEN 'rebook' THEN 'online' WHEN 'api' THEN 'app' WHEN 'walk_in' THEN 'walk_in' WHEN 'import' THEN 'import' ELSE 'staff' END;
		who := CASE WHEN n.source IN ('online', 'api', 'rebook') THEN 'client' WHEN n.source = 'import' THEN 'system' ELSE 'staff' END;
		-- Booked by staff right after the client rang the shop: a phone booking.
		IF n.source = 'staff' AND n.customer_id IS NOT NULL THEN
			SELECT c."id" INTO call_id FROM "call_logs" c
			WHERE c."customer_id" = n.customer_id AND c."direction" = 'in' AND (c."shop_id" IS NULL OR c."shop_id" = n.shop_id)
				AND c."created_at" BETWEEN n.created_at - interval '2 hours' AND n.created_at
			ORDER BY c."created_at" DESC LIMIT 1;
			IF call_id IS NOT NULL THEN ch := 'phone'; END IF;
		END IF;
		PERFORM "analytics_emit"(base || jsonb_build_object(
			'event', 'booking.created', 'key', 'booking.created:' || n.id, 'at', n.created_at, 'actor_kind', who, 'channel', ch,
			'amount', n.estimate_cents, 'minutes', CASE WHEN n.booked_at_known THEN "analytics_minutes"(n.created_at, n.starts_at) END,
			'value', "analytics_minutes"(n.starts_at, n.ends_at),
			'subtype', CASE WHEN n.group_id IS NOT NULL THEN 'group' WHEN n.rebooked_from_id IS NOT NULL THEN 'rebook' WHEN n.any_barber THEN 'any_barber' ELSE 'barber' END,
			'props', jsonb_build_object('group', n.group_id, 'rebooked_from', n.rebooked_from_id, 'squeezed', nullif(n.squeezed, false), 'any_barber', nullif(n.any_barber, false), 'call', call_id, 'lead_unknown', nullif(NOT n.booked_at_known, false))
		));
		IF call_id IS NOT NULL THEN
			PERFORM "analytics_emit"(base || jsonb_build_object('event', 'call.booked', 'key', 'call.booked:' || call_id || ':' || n.id, 'at', n.created_at, 'actor_kind', 'staff', 'channel', 'phone', 'entity', 'call', 'entity_id', call_id, 'amount', n.estimate_cents));
		END IF;
		IF n.customer_id IS NOT NULL AND n.source <> 'import' THEN
			SELECT coalesce(("marketing"->>'attributionDays')::int, 7) INTO days FROM "brand_settings" LIMIT 1;
			SELECT ms."id", ms."campaign_id", ms."channel", ms."first_click_at" INTO send FROM "marketing_sends" ms
			WHERE ms."customer_id" = n.customer_id AND ms."status" = 'queued' AND ms."created_at" <= n.created_at AND ms."created_at" > n.created_at - make_interval(days => coalesce(days, 7))
			ORDER BY ms."created_at" DESC LIMIT 1;
			IF FOUND THEN
				PERFORM "analytics_emit"(base || jsonb_build_object('event', 'campaign.booked', 'key', 'campaign.booked:' || n.id, 'at', n.created_at, 'actor_kind', who, 'channel', send.channel,
					'entity', 'campaign', 'entity_id', send.campaign_id, 'amount', n.estimate_cents, 'subtype', CASE WHEN send.first_click_at IS NOT NULL THEN 'clicked' ELSE 'sent' END,
					'minutes', NULL, 'props', jsonb_build_object('send', send.id)));
			END IF;
		END IF;
	ELSIF (n.starts_at <> o.starts_at OR n.staff_id <> o.staff_id) AND n.status NOT IN ('cancelled', 'no_show', 'completed') THEN
		PERFORM "analytics_emit"(base || jsonb_build_object(
			'event', 'booking.rescheduled', 'key', 'booking.rescheduled:' || n.id || ':' || "analytics_epoch"(o.starts_at) || ':' || "analytics_epoch"(n.starts_at) || ':' || n.staff_id,
			'minutes', "analytics_minutes"(clock_timestamp(), n.starts_at), 'value', "analytics_minutes"(o.starts_at, n.starts_at), 'amount', n.estimate_cents,
			'subtype', CASE WHEN n.staff_id <> o.staff_id AND n.starts_at <> o.starts_at THEN 'time_and_barber' WHEN n.staff_id <> o.staff_id THEN 'barber' ELSE 'time' END,
			'props', jsonb_build_object('from_staff', CASE WHEN n.staff_id <> o.staff_id THEN o.staff_id END, 'from_start', o.starts_at)
		));
	END IF;
	IF n.status = 'confirmed' AND (o IS NULL OR o.status <> 'confirmed') AND NOT backfill THEN
		PERFORM "analytics_emit"(base || jsonb_build_object('event', 'booking.confirmed', 'key', 'booking.confirmed:' || n.id, 'minutes', "analytics_minutes"(clock_timestamp(), n.starts_at)));
	END IF;
	IF n.status = 'cancelled' AND (o IS NULL OR o.status <> 'cancelled') THEN
		at := coalesce(n.cancelled_at, CASE WHEN backfill OR o IS NULL THEN n.starts_at ELSE clock_timestamp() END);
		lead := "analytics_minutes"(at, n.starts_at);
		SELECT "cancel_cutoff_minutes" INTO cutoff FROM "shops" WHERE "id" = n.shop_id;
		PERFORM "analytics_emit"(base || jsonb_build_object(
			'event', 'booking.cancelled', 'key', 'booking.cancelled:' || n.id || ':' || "analytics_epoch"(at), 'at', at,
			'actor_kind', CASE n.cancelled_by WHEN 'customer' THEN 'client' WHEN 'staff' THEN 'staff' END,
			'minutes', lead, 'amount', n.estimate_cents, 'reason', n.cancel_reason,
			'subtype', CASE WHEN lead < 0 THEN 'after_start' WHEN lead < coalesce(cutoff, 0) THEN 'late' ELSE 'in_time' END,
			'props', jsonb_build_object('by', n.cancelled_by, 'cutoff', cutoff)
		));
	END IF;
	IF n.status = 'no_show' AND (o IS NULL OR o.status <> 'no_show') THEN
		PERFORM "analytics_emit"(base || jsonb_build_object('event', 'appointment.no_show', 'key', 'appointment.no_show:' || n.id,
			'at', CASE WHEN backfill OR o IS NULL THEN n.starts_at ELSE clock_timestamp() END, 'amount', n.estimate_cents, 'value', "analytics_minutes"(n.starts_at, n.ends_at)));
	END IF;
	IF n.status = 'completed' AND (o IS NULL OR o.status <> 'completed') THEN
		PERFORM "analytics_emit"(base || jsonb_build_object('event', 'appointment.completed', 'key', 'appointment.completed:' || n.id,
			'at', coalesce(n.completed_at, CASE WHEN backfill OR o IS NULL THEN n.ends_at ELSE clock_timestamp() END), 'amount', n.estimate_cents, 'value', "analytics_minutes"(n.starts_at, n.ends_at)));
	END IF;
	IF NOT (o IS NULL) AND o.status IN ('cancelled', 'no_show') AND n.status NOT IN ('cancelled', 'no_show') THEN
		PERFORM "analytics_emit"(base || jsonb_build_object('event', 'booking.restored', 'key', 'booking.restored:' || n.id || ':' || "analytics_epoch"(clock_timestamp()), 'subtype', o.status));
	END IF;
	RETURN 1;
END $$;--> statement-breakpoint
-- Same 5-minute tolerance as ON_TIME_TOLERANCE_MIN in src/domain/service-times.ts.
CREATE OR REPLACE FUNCTION "analytics_appointment_times"(n "appointment_times", o "appointment_times", backfill boolean) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
	a "appointments";
	base jsonb;
	m double precision;
	actual double precision;
	booked double precision;
BEGIN
	IF n.appointment_id IS NULL THEN RETURN 0; END IF;
	SELECT * INTO a FROM "appointments" WHERE "id" = n.appointment_id;
	IF NOT FOUND THEN RETURN 0; END IF;
	booked := "analytics_minutes"(a.starts_at, a.ends_at);
	base := jsonb_build_object('shop', a.shop_id, 'staff', a.staff_id, 'customer', a.customer_id, 'source', a.source, 'entity', 'appointment', 'entity_id', a.id, 'appointment', a.id, 'backfill', backfill);
	IF n.arrived_at IS NOT NULL AND (o IS NULL OR o.arrived_at IS NULL) THEN
		m := "analytics_minutes"(a.starts_at, n.arrived_at);
		PERFORM "analytics_emit"(base || jsonb_build_object('event', 'appointment.arrived', 'key', 'appointment.arrived:' || a.id, 'at', n.arrived_at, 'actor', n.arrived_by,
			'minutes', m, 'subtype', CASE WHEN a.source = 'walk_in' THEN 'walk_in' WHEN m > 5 THEN 'late' WHEN m < -5 THEN 'early' ELSE 'on_time' END));
	END IF;
	IF n.started_at IS NOT NULL AND (o IS NULL OR o.started_at IS NULL) THEN
		m := "analytics_minutes"(a.starts_at, n.started_at);
		PERFORM "analytics_emit"(base || jsonb_build_object('event', 'appointment.started', 'key', 'appointment.started:' || a.id, 'at', n.started_at, 'actor', n.started_by,
			'minutes', CASE WHEN n.arrived_at IS NOT NULL THEN greatest(0, "analytics_minutes"(n.arrived_at, n.started_at)) END, 'value', m,
			'subtype', CASE WHEN a.source = 'walk_in' THEN 'walk_in' WHEN m > 5 THEN 'late' ELSE 'on_time' END));
	END IF;
	IF n.finished_at IS NOT NULL AND (o IS NULL OR o.finished_at IS NULL) THEN
		actual := CASE WHEN n.started_at IS NOT NULL THEN greatest(0, "analytics_minutes"(n.started_at, n.finished_at)) END;
		PERFORM "analytics_emit"(base || jsonb_build_object('event', 'appointment.finished', 'key', 'appointment.finished:' || a.id, 'at', n.finished_at, 'actor', n.finished_by,
			'minutes', actual, 'value', booked,
			'subtype', CASE WHEN actual IS NULL THEN NULL WHEN actual > booked + 5 THEN 'over' WHEN actual < booked - 5 THEN 'under' ELSE 'on_pace' END,
			'props', jsonb_build_object('via', n.finished_via)));
	END IF;
	IF n.corrected_at IS NOT NULL AND (o IS NULL OR o.corrected_at IS DISTINCT FROM n.corrected_at) THEN
		PERFORM "analytics_emit"(base || jsonb_build_object('event', 'appointment.times_corrected', 'key', 'appointment.times_corrected:' || a.id || ':' || "analytics_epoch"(n.corrected_at), 'at', n.corrected_at, 'actor', n.corrected_by,
			'minutes', CASE WHEN n.started_at IS NOT NULL AND n.finished_at IS NOT NULL THEN "analytics_minutes"(n.started_at, n.finished_at) END, 'value', booked,
			'subtype', n.review, 'props', jsonb_build_object('arrived', n.arrived_at, 'started', n.started_at, 'finished', n.finished_at)));
	END IF;
	RETURN 1;
END $$;--> statement-breakpoint
-- One event per line sold, once its ticket is paid (checkout rebuilds an open ticket's lines, so lines on an open ticket aren't final).
CREATE OR REPLACE FUNCTION "analytics_ticket_line"(li "sale_items", s "sales", backfill boolean) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
	base jsonb;
BEGIN
	base := jsonb_build_object('shop', s.shop_id, 'staff', coalesce(li.staff_id, s.staff_id), 'customer', s.customer_id, 'entity', 'ticket', 'entity_id', s.id, 'sale', s.id,
		'appointment', coalesce(li.appointment_id, s.appointment_id), 'at', coalesce(s.paid_at, s.created_at), 'backfill', backfill, 'channel', CASE WHEN s.is_imported THEN 'import' END,
		'actor_kind', CASE WHEN s.is_imported THEN 'system' ELSE 'staff' END);
	PERFORM "analytics_emit"(base || jsonb_build_object('event', 'ticket.line', 'key', 'ticket.line:' || li.id, 'subtype', li.kind, 'quantity', li.qty, 'amount', li.net_cents, 'value', li.unit_price_cents,
		'props', jsonb_build_object('line', li.id, 'item', li.ref_id, 'gross', li.gross_cents, 'discount', li.discount_cents, 'tax', li.tax_cents, 'catalog_price', li.catalog_price_cents,
			'overridden', CASE WHEN li.override_reason IS NOT NULL THEN true END, 'refunded_qty', nullif(li.refunded_qty, 0))));
	IF li.override_reason IS NOT NULL THEN
		PERFORM "analytics_emit"(base || jsonb_build_object('event', 'ticket.price_override', 'key', 'ticket.price_override:' || li.id, 'subtype', li.kind, 'quantity', li.qty,
			'amount', li.unit_price_cents, 'value', li.catalog_price_cents, 'reason', li.override_reason, 'props', jsonb_build_object('line', li.id, 'item', li.ref_id)));
	END IF;
END $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "analytics_sale_items"(n "sale_items", o "sale_items", backfill boolean) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
	s "sales";
BEGIN
	IF n.id IS NULL THEN RETURN 0; END IF;
	SELECT * INTO s FROM "sales" WHERE "id" = n.sale_id;
	IF NOT FOUND OR s.status = 'open' OR s.paid_at IS NULL THEN RETURN 0; END IF;
	PERFORM "analytics_ticket_line"(n, s, backfill);
	RETURN 1;
END $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "analytics_sales"(n "sales", o "sales", backfill boolean) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
	base jsonb;
	net integer := n.service_net_cents + n.product_net_cents;
	li record;
	line "sale_items";
	svc boolean;
	prod boolean;
	at timestamptz;
	merged boolean := n.merged_into_sale_id IS NOT NULL;
BEGIN
	IF n.id IS NULL THEN RETURN 0; END IF;
	base := jsonb_build_object('shop', n.shop_id, 'staff', n.staff_id, 'customer', n.customer_id, 'entity', 'ticket', 'entity_id', n.id, 'sale', n.id, 'appointment', n.appointment_id, 'backfill', backfill,
		'channel', CASE WHEN n.is_imported THEN 'import' END, 'actor_kind', CASE WHEN n.is_imported THEN 'system' ELSE 'staff' END);
	IF o IS NULL AND NOT n.is_imported THEN
		PERFORM "analytics_emit"(base || jsonb_build_object('event', 'ticket.opened', 'key', 'ticket.opened:' || n.id, 'at', n.created_at, 'actor', n.created_by, 'props', jsonb_build_object('number', n.number)));
	END IF;
	IF NOT (o IS NULL) AND n.status = 'open' AND n.discount_cents <> o.discount_cents THEN
		PERFORM "analytics_emit"(base || jsonb_build_object('event', 'ticket.discount_changed', 'key', 'ticket.discount_changed:' || n.id || ':' || "analytics_epoch"(clock_timestamp()),
			'amount', n.discount_cents, 'value', n.discount_cents - o.discount_cents, 'props', jsonb_build_object('promo', n.promo_code_id)));
	END IF;
	IF NOT (o IS NULL) AND n.staff_id IS DISTINCT FROM o.staff_id THEN
		PERFORM "analytics_emit"(base || jsonb_build_object('event', 'ticket.reassigned', 'key', 'ticket.reassigned:' || n.id || ':' || "analytics_epoch"(clock_timestamp()), 'props', jsonb_build_object('from_staff', o.staff_id)));
	END IF;
	IF n.paid_at IS NOT NULL AND n.status IN ('paid', 'refunded', 'partially_refunded') AND (o IS NULL OR o.status = 'open' OR o.paid_at IS NULL) THEN
		SELECT count(*)::int lines, coalesce(bool_or("kind" IN ('service', 'addon')), false) svc, coalesce(bool_or("kind" = 'product'), false) prod, coalesce(sum("qty") FILTER (WHERE "kind" = 'product'), 0)::int units
			INTO li FROM "sale_items" WHERE "sale_id" = n.id;
		svc := li.svc OR n.service_gross_cents > 0;
		prod := li.prod OR n.product_gross_cents > 0;
		PERFORM "analytics_emit"(base || jsonb_build_object('event', 'ticket.paid', 'key', 'ticket.paid:' || n.id, 'at', n.paid_at, 'amount', net, 'quantity', li.lines,
			'value', CASE WHEN net > 0 THEN n.tip_cents * 100.0 / net END,
			'subtype', CASE WHEN svc AND prod THEN 'service_and_retail' WHEN svc THEN 'service_only' WHEN prod THEN 'retail_only' ELSE 'other' END,
			'props', jsonb_build_object('number', n.number, 'service_net', n.service_net_cents, 'product_net', n.product_net_cents, 'service_gross', n.service_gross_cents, 'product_gross', n.product_gross_cents,
				'discount', n.discount_cents, 'tax', n.service_tax_cents + n.product_tax_cents, 'tip', n.tip_cents, 'card_fee', n.card_fee_cents, 'total', n.total_cents,
				'gift_cards', nullif(n.gift_card_sales_cents, 0), 'loyalty_earned', nullif(n.loyalty_earned_cents, 0), 'promo', n.promo_code_id, 'product_units', li.units, 'imported', nullif(n.is_imported, false))));
		FOR line IN SELECT * FROM "sale_items" WHERE "sale_id" = n.id LOOP
			PERFORM "analytics_ticket_line"(line, n, backfill);
		END LOOP;
	END IF;
	IF n.status = 'voided' AND (o IS NULL OR o.status <> 'voided') THEN
		at := coalesce(n.voided_at, CASE WHEN backfill OR o IS NULL THEN n.created_at ELSE clock_timestamp() END);
		PERFORM "analytics_emit"(base || jsonb_build_object('event', CASE WHEN merged THEN 'ticket.merged' ELSE 'ticket.voided' END, 'key', 'ticket.voided:' || n.id, 'at', at,
			'amount', net, 'reason', CASE WHEN merged THEN NULL ELSE n.void_reason END,
			'subtype', CASE WHEN NOT (o IS NULL) THEN o.status::text WHEN n.paid_at IS NOT NULL THEN 'paid' ELSE 'open' END,
			'props', jsonb_build_object('into', n.merged_into_sale_id, 'approved_by', n.void_approved_by, 'number', n.number)));
	END IF;
	RETURN 1;
END $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "analytics_refunds"(n "refunds", o "refunds", backfill boolean) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
	s "sales";
BEGIN
	IF n.id IS NULL OR NOT (o IS NULL) THEN RETURN 0; END IF;
	SELECT * INTO s FROM "sales" WHERE "id" = n.sale_id;
	PERFORM "analytics_emit"(jsonb_build_object('event', CASE WHEN n.kind = 'void' THEN 'payment.voided' ELSE 'ticket.refunded' END, 'key', 'refund:' || n.id, 'at', n.created_at, 'backfill', backfill,
		'shop', n.shop_id, 'staff', s.staff_id, 'customer', s.customer_id, 'entity', 'ticket', 'entity_id', n.sale_id, 'sale', n.sale_id, 'appointment', s.appointment_id, 'actor', n.created_by,
		'amount', n.amount_cents, 'subtype', n.method, 'reason', n.reason,
		'props', jsonb_build_object('payment', n.payment_id, 'service_net', n.service_net_cents, 'product_net', n.product_net_cents, 'gift_cards', nullif(n.gift_card_sales_cents, 0), 'tax', n.tax_cents,
			'tip', n.tip_cents, 'card_fee', n.card_fee_cents, 'via', n.source, 'approved_by', n.approved_by, 'partial', CASE WHEN n.items IS NOT NULL THEN true END)));
	RETURN 1;
END $$;--> statement-breakpoint
-- The card's brand and funding are kept for the mix of how people pay; never its number or last four digits.
CREATE OR REPLACE FUNCTION "analytics_payments"(n "payments", o "payments", backfill boolean) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
	s "sales";
	base jsonb;
	net integer;
	at timestamptz;
BEGIN
	IF n.id IS NULL THEN RETURN 0; END IF;
	SELECT * INTO s FROM "sales" WHERE "id" = n.sale_id;
	net := coalesce(s.service_net_cents + s.product_net_cents, 0);
	at := CASE WHEN backfill OR o IS NULL THEN n.created_at ELSE clock_timestamp() END;
	base := jsonb_build_object('shop', n.shop_id, 'staff', s.staff_id, 'customer', s.customer_id, 'entity', 'payment', 'entity_id', n.id, 'sale', n.sale_id, 'appointment', s.appointment_id,
		'backfill', backfill, 'at', at, 'subtype', n.method, 'device', CASE WHEN n.terminal_reader_id IS NOT NULL THEN 'reader' END,
		'channel', CASE WHEN s.is_imported THEN 'import' END, 'actor_kind', CASE WHEN s.is_imported THEN 'system' ELSE 'staff' END);
	IF n.status IN ('succeeded', 'refunded', 'partially_refunded') AND (o IS NULL OR o.status IN ('pending', 'failed')) THEN
		PERFORM "analytics_emit"(base || jsonb_build_object('event', 'payment.taken', 'key', 'payment.taken:' || n.id, 'amount', n.amount_cents,
			'props', jsonb_build_object('tip', n.tip_cents, 'card_fee', n.card_fee_cents, 'entry_mode', n.entry_mode, 'card_brand', n.card_brand, 'funding', n.card_funding, 'settlement', n.settlement,
				'processor', n.processor, 'gift_card', CASE WHEN n.gift_card_id IS NOT NULL THEN true END, 'other_payer', CASE WHEN n.payer_customer_id IS DISTINCT FROM s.customer_id AND n.payer_customer_id IS NOT NULL THEN true END)));
		IF n.tip_cents > 0 THEN
			PERFORM "analytics_emit"(base || jsonb_build_object('event', 'tip.recorded', 'key', 'tip.recorded:' || n.id, 'amount', n.tip_cents, 'value', CASE WHEN net > 0 THEN n.tip_cents * 100.0 / net END,
				'entity', 'ticket', 'entity_id', n.sale_id));
		END IF;
	ELSIF n.status = 'failed' AND (o IS NULL OR o.status <> 'failed') THEN
		PERFORM "analytics_emit"(base || jsonb_build_object('event', 'payment.failed', 'key', 'payment.failed:' || n.id, 'amount', n.amount_cents, 'props', jsonb_build_object('entry_mode', n.entry_mode)));
	END IF;
	RETURN 1;
END $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "analytics_coupon_redemptions"(n "coupon_redemptions", o "coupon_redemptions", backfill boolean) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
	base jsonb;
BEGIN
	IF n.id IS NULL THEN RETURN 0; END IF;
	base := jsonb_build_object('shop', n.shop_id, 'staff', n.staff_id, 'customer', n.customer_id, 'entity', 'promo', 'entity_id', n.promo_id, 'sale', n.sale_id, 'backfill', backfill,
		'amount', n.discount_cents, 'subtype', n.via, 'props', jsonb_build_object('code', n.coupon_code_id, 'campaign', n.campaign_id));
	IF o IS NULL THEN
		PERFORM "analytics_emit"(base || jsonb_build_object('event', 'discount.coupon_redeemed', 'key', 'discount.coupon_redeemed:' || n.id, 'at', n.created_at));
	END IF;
	IF n.reversed_at IS NOT NULL AND (o IS NULL OR o.reversed_at IS NULL) THEN
		PERFORM "analytics_emit"(base || jsonb_build_object('event', 'discount.coupon_reversed', 'key', 'discount.coupon_reversed:' || n.id, 'at', n.reversed_at));
	END IF;
	RETURN 1;
END $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "analytics_inventory_ledger"(n "inventory_ledger", o "inventory_ledger", backfill boolean) RETURNS integer LANGUAGE plpgsql AS $$
BEGIN
	IF n.id IS NULL OR NOT (o IS NULL) THEN RETURN 0; END IF;
	PERFORM "analytics_emit"(jsonb_build_object('event', 'inventory.moved', 'key', 'inventory.moved:' || n.id, 'at', n.created_at, 'backfill', backfill,
		'shop', n.shop_id, 'staff', n.staff_id, 'actor', n.staff_id, 'entity', 'product', 'entity_id', n.product_id, 'sale', n.sale_id,
		'quantity', n.delta, 'value', n.balance_after, 'amount', CASE WHEN n.unit_cost_cents IS NOT NULL THEN n.unit_cost_cents * n.delta END, 'subtype', n.kind, 'reason', n.reason,
		'props', jsonb_build_object('unit_cost', n.unit_cost_cents, 'purchase_order', n.purchase_order_id, 'receipt', n.receipt_id, 'transfer', n.transfer_id, 'count', n.count_id)));
	RETURN 1;
END $$;--> statement-breakpoint
-- Location, IP address and photo are never logged; only whether there was a photo and which check let the punch in.
CREATE OR REPLACE FUNCTION "analytics_time_punches"(n "time_punches", o "time_punches", backfill boolean) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
	base jsonb;
BEGIN
	IF n.id IS NULL THEN RETURN 0; END IF;
	base := jsonb_build_object('shop', n.shop_id, 'staff', n.staff_id, 'entity', 'punch', 'entity_id', n.id, 'backfill', backfill, 'subtype', n.method,
		'channel', CASE WHEN n.source = 'kiosk' THEN 'kiosk' ELSE 'staff_app' END, 'device', CASE WHEN n.source = 'kiosk' THEN 'kiosk' END);
	IF o IS NULL THEN
		PERFORM "analytics_emit"(base || jsonb_build_object('event', 'clock.' || n.type, 'key', 'clock:' || n.id, 'at', n.original_at, 'actor', coalesce(n.created_by, n.staff_id),
			'value', n.off_schedule_min, 'minutes', n.planned_min,
			'props', jsonb_build_object('flags', CASE WHEN jsonb_typeof(n.flags) = 'array' AND n.flags <> '[]'::jsonb THEN n.flags END, 'photo', nullif(n.has_photo, false), 'reason_id', n.reason_id,
				'added_by_manager', CASE WHEN n.created_by IS NOT NULL AND n.created_by <> n.staff_id THEN true END)));
	END IF;
	IF n.edited_at IS NOT NULL AND (o IS NULL OR o.edited_at IS DISTINCT FROM n.edited_at) THEN
		PERFORM "analytics_emit"(base || jsonb_build_object('event', 'clock.edited', 'key', 'clock.edited:' || n.id || ':' || "analytics_epoch"(n.edited_at), 'at', n.edited_at,
			'value', "analytics_minutes"(n.original_at, n.at), 'props', jsonb_build_object('type', n.type)));
	END IF;
	IF n.voided_at IS NOT NULL AND (o IS NULL OR o.voided_at IS NULL) THEN
		PERFORM "analytics_emit"(base || jsonb_build_object('event', 'clock.voided', 'key', 'clock.voided:' || n.id, 'at', n.voided_at, 'props', jsonb_build_object('type', n.type)));
	END IF;
	RETURN 1;
END $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "analytics_time_blocks"(n "time_blocks", o "time_blocks", backfill boolean) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
	r "time_blocks" := CASE WHEN n.id IS NULL THEN o ELSE n END;
	priv boolean;
	base jsonb;
BEGIN
	IF r.id IS NULL OR r.source <> 'manual' OR (n.id IS NOT NULL AND NOT (o IS NULL)) THEN RETURN 0; END IF;
	priv := "analytics_private_reason"(r.reason_id);
	base := jsonb_build_object('shop', r.shop_id, 'staff', r.staff_id, 'entity', 'block', 'entity_id', r.id, 'backfill', backfill,
		'subtype', CASE WHEN r.kind = 'day_off' THEN 'day_off' ELSE r.category END, 'minutes', "analytics_minutes"(r.starts_at, r.ends_at),
		'reason', CASE WHEN priv THEN NULL ELSE r.reason END,
		'props', jsonb_build_object('reason_id', r.reason_id, 'private', nullif(priv, false), 'series', r.series_id, 'time_off', r.request_id, 'starts', r.starts_at));
	IF n.id IS NOT NULL THEN
		PERFORM "analytics_emit"(base || jsonb_build_object('event', 'block.added', 'key', 'block.added:' || r.id, 'at', r.created_at, 'actor', r.created_by, 'value', "analytics_minutes"(r.created_at, r.starts_at)));
	ELSE
		PERFORM "analytics_emit"(base || jsonb_build_object('event', 'block.removed', 'key', 'block.removed:' || r.id, 'value', "analytics_minutes"(clock_timestamp(), r.starts_at)));
	END IF;
	RETURN 1;
END $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "analytics_time_off_requests"(n "time_off_requests", o "time_off_requests", backfill boolean) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
	priv boolean;
	base jsonb;
BEGIN
	IF n.id IS NULL THEN RETURN 0; END IF;
	priv := "analytics_private_reason"(n.reason_id);
	base := jsonb_build_object('shop', n.shop_id, 'staff', n.staff_id, 'entity', 'time_off', 'entity_id', n.id, 'backfill', backfill,
		'minutes', "analytics_minutes"(n.starts_at, n.ends_at), 'reason', CASE WHEN priv THEN NULL ELSE n.reason END,
		'props', jsonb_build_object('from', n.from_date, 'to', n.to_date, 'reason_id', n.reason_id, 'private', nullif(priv, false)));
	IF o IS NULL THEN
		PERFORM "analytics_emit"(base || jsonb_build_object('event', 'time_off.requested', 'key', 'time_off.requested:' || n.id, 'at', n.created_at, 'actor', n.requested_by,
			'value', "analytics_minutes"(n.created_at, n.starts_at) / 1440.0));
	END IF;
	IF n.status <> 'pending' AND n.status ~ '^[a-z_]+$' AND (o IS NULL OR o.status IS DISTINCT FROM n.status) THEN
		PERFORM "analytics_emit"(base || jsonb_build_object('event', 'time_off.' || n.status, 'key', 'time_off.' || n.status || ':' || n.id,
			'at', coalesce(n.decided_at, CASE WHEN backfill OR o IS NULL THEN n.updated_at ELSE clock_timestamp() END), 'actor', n.decided_by, 'subtype', n.decided_via,
			'value', CASE WHEN n.decided_at IS NOT NULL THEN "analytics_minutes"(n.created_at, n.decided_at) / 60.0 END));
	END IF;
	RETURN 1;
END $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "analytics_call_ins"(n "call_ins", o "call_ins", backfill boolean) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
	priv boolean;
	base jsonb;
BEGIN
	IF n.id IS NULL THEN RETURN 0; END IF;
	priv := "analytics_private_reason"(n.reason_id);
	base := jsonb_build_object('shop', n.shop_id, 'staff', n.staff_id, 'entity', 'call_in', 'entity_id', n.id, 'backfill', backfill, 'subtype', n.kind,
		'minutes', "analytics_minutes"(n.starts_at, n.ends_at), 'reason', CASE WHEN priv THEN NULL ELSE n.reason END,
		'props', jsonb_build_object('reason_id', n.reason_id, 'private', nullif(priv, false), 'from', n.from_date, 'to', n.to_date));
	IF o IS NULL THEN
		PERFORM "analytics_emit"(base || jsonb_build_object('event', 'staff.called_in', 'key', 'staff.called_in:' || n.id, 'at', n.created_at, 'actor', n.created_by,
			'value', "analytics_minutes"(n.created_at, n.starts_at)));
	END IF;
	IF n.cancelled_at IS NOT NULL AND (o IS NULL OR o.cancelled_at IS NULL) THEN
		PERFORM "analytics_emit"(base || jsonb_build_object('event', 'staff.call_in_cancelled', 'key', 'staff.call_in_cancelled:' || n.id, 'at', n.cancelled_at, 'actor', n.cancelled_by));
	END IF;
	RETURN 1;
END $$;--> statement-breakpoint
-- Where a message went and how it did; never who it was to or what it said.
CREATE OR REPLACE FUNCTION "analytics_notification_jobs"(n "notification_jobs", o "notification_jobs", backfill boolean) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
	base jsonb;
BEGIN
	IF n.id IS NULL THEN RETURN 0; END IF;
	base := jsonb_build_object('shop', n.shop_id, 'customer', n.customer_id, 'appointment', n.appointment_id, 'entity', 'message', 'entity_id', n.id, 'backfill', backfill,
		'channel', n.channel, 'subtype', n.kind, 'staff', (SELECT "staff_id" FROM "appointments" WHERE "id" = n.appointment_id));
	IF o IS NULL THEN
		PERFORM "analytics_emit"(base || jsonb_build_object('event', 'message.queued', 'key', 'message.queued:' || n.id, 'at', n.created_at,
			'value', "analytics_minutes"(n.created_at, n.run_at), 'props', jsonb_build_object('outreach', n.outreach_id)));
	END IF;
	IF n.status IN ('sent', 'failed', 'suppressed', 'cancelled') AND (o IS NULL OR o.status IS DISTINCT FROM n.status) THEN
		PERFORM "analytics_emit"(base || jsonb_build_object('event', 'message.' || n.status, 'key', 'message.' || n.status || ':' || n.id,
			'at', coalesce(CASE WHEN n.status = 'sent' THEN n.sent_at END, CASE WHEN backfill OR o IS NULL THEN n.run_at ELSE clock_timestamp() END),
			'quantity', n.attempts, 'props', jsonb_build_object('provider', n.provider)));
	END IF;
	IF n.delivered_at IS NOT NULL AND (o IS NULL OR o.delivered_at IS NULL) THEN
		PERFORM "analytics_emit"(base || jsonb_build_object('event', 'message.delivered', 'key', 'message.delivered:' || n.id, 'at', n.delivered_at,
			'minutes', CASE WHEN n.sent_at IS NOT NULL THEN "analytics_minutes"(n.sent_at, n.delivered_at) END));
	END IF;
	RETURN 1;
END $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "analytics_marketing_sends"(n "marketing_sends", o "marketing_sends", backfill boolean) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
	base jsonb;
BEGIN
	IF n.id IS NULL OR n.status = 'test' THEN RETURN 0; END IF;
	base := jsonb_build_object('shop', n.shop_id, 'staff', n.staff_id, 'customer', n.customer_id, 'entity', 'campaign', 'entity_id', n.campaign_id, 'backfill', backfill, 'channel', n.channel,
		'actor_kind', 'system', 'props', jsonb_build_object('send', n.id, 'step', n.step_id, 'coupon', CASE WHEN n.coupon_code_id IS NOT NULL THEN true END));
	IF o IS NULL THEN
		PERFORM "analytics_emit"(base || jsonb_build_object('event', CASE WHEN n.status = 'skipped' THEN 'campaign.skipped' ELSE 'campaign.sent' END, 'key', 'campaign.sent:' || n.id, 'at', n.created_at,
			'subtype', n.skipped, 'amount', n.cost_cents));
	END IF;
	IF n.first_click_at IS NOT NULL AND (o IS NULL OR o.first_click_at IS NULL) THEN
		PERFORM "analytics_emit"(base || jsonb_build_object('event', 'campaign.clicked', 'key', 'campaign.clicked:' || n.id, 'at', n.first_click_at, 'actor_kind', 'client',
			'minutes', "analytics_minutes"(n.created_at, n.first_click_at), 'quantity', n.clicks));
	END IF;
	RETURN 1;
END $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "analytics_review_clicks"(n "review_clicks", o "review_clicks", backfill boolean) RETURNS integer LANGUAGE plpgsql AS $$
BEGIN
	IF n.id IS NULL OR NOT (o IS NULL) THEN RETURN 0; END IF;
	PERFORM "analytics_emit"(jsonb_build_object('event', 'review.clicked', 'key', 'review.clicked:' || n.id, 'at', n.created_at, 'backfill', backfill, 'actor_kind', 'client',
		'shop', n.shop_id, 'staff', n.staff_id, 'customer', (SELECT "customer_id" FROM "sales" WHERE "id" = n.sale_id), 'entity', 'ticket', 'entity_id', n.sale_id, 'sale', n.sale_id,
		'subtype', n.source, 'channel', n.source, 'props', jsonb_build_object('delivery', n.delivery_id)));
	RETURN 1;
END $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "analytics_client_badges"(n "client_badges", o "client_badges", backfill boolean) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
	k text;
	day text;
	shop uuid;
BEGIN
	IF n.customer_id IS NULL THEN RETURN 0; END IF;
	SELECT "home_shop_id" INTO shop FROM "customers" WHERE "id" = n.customer_id;
	FOR k IN SELECT unnest(n.keys) EXCEPT SELECT unnest(coalesce(o.keys, '{}'::text[])) LOOP
		day := CASE WHEN n.since->>k ~ '^\d{4}-\d{2}-\d{2}$' THEN n.since->>k END;
		PERFORM "analytics_emit"(jsonb_build_object('event', 'badge.earned', 'key', 'badge.earned:' || n.customer_id || ':' || k || ':' || coalesce(day, n.changed_at::date::text),
			'at', CASE WHEN o IS NULL AND day IS NOT NULL THEN (day || ' 12:00')::timestamp AT TIME ZONE 'America/Chicago' ELSE n.changed_at END,
			'backfill', backfill, 'actor_kind', 'system', 'shop', shop, 'customer', n.customer_id, 'entity', 'client', 'entity_id', n.customer_id, 'subtype', k));
	END LOOP;
	IF NOT (o IS NULL) THEN
		FOR k IN SELECT unnest(o.keys) EXCEPT SELECT unnest(n.keys) LOOP
			PERFORM "analytics_emit"(jsonb_build_object('event', 'badge.lost', 'key', 'badge.lost:' || n.customer_id || ':' || k || ':' || "analytics_epoch"(n.changed_at), 'at', n.changed_at,
				'actor_kind', 'system', 'shop', shop, 'customer', n.customer_id, 'entity', 'client', 'entity_id', n.customer_id, 'subtype', k));
		END LOOP;
	END IF;
	RETURN 1;
END $$;--> statement-breakpoint
-- Which tools the assistant used and whether they worked; never the question, the answer or the tools' arguments.
CREATE OR REPLACE FUNCTION "analytics_assistant_messages"(n "assistant_messages", o "assistant_messages", backfill boolean) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
	tools jsonb := CASE WHEN jsonb_typeof(n.tools) = 'array' THEN n.tools ELSE '[]'::jsonb END;
BEGIN
	IF n.id IS NULL OR NOT (o IS NULL) OR n.role NOT IN ('user', 'assistant') THEN RETURN 0; END IF;
	PERFORM "analytics_emit"(jsonb_build_object('event', CASE WHEN n.role = 'user' THEN 'assistant.asked' ELSE 'assistant.answered' END, 'key', 'assistant:' || n.id, 'at', n.created_at,
		'backfill', backfill, 'actor', CASE WHEN n.role = 'user' THEN n.staff_id END, 'actor_kind', CASE WHEN n.role = 'user' THEN 'staff' ELSE 'system' END, 'staff', n.staff_id,
		'entity', 'assistant_conversation', 'entity_id', n.conversation_id, 'channel', 'assistant',
		'quantity', CASE WHEN n.role = 'assistant' THEN jsonb_array_length(tools) END, 'value', char_length(n.body),
		'props', jsonb_build_object(
			'tools', CASE WHEN n.role = 'assistant' AND jsonb_array_length(tools) > 0 THEN (SELECT jsonb_agg(DISTINCT t->>'name') FROM jsonb_array_elements(tools) t WHERE jsonb_typeof(t) = 'object' AND t->>'name' ~ '^[a-z_]+$') END,
			'failed', CASE WHEN n.role = 'assistant' THEN nullif((SELECT count(*) FROM jsonb_array_elements(tools) t WHERE jsonb_typeof(t) = 'object' AND t->>'ok' = 'false'), 0) END)));
	RETURN 1;
END $$;--> statement-breakpoint
-- Calls by kind and how they ended; never the number or the digits pressed.
CREATE OR REPLACE FUNCTION "analytics_call_logs"(n "call_logs", o "call_logs", backfill boolean) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
	base jsonb;
	at timestamptz;
BEGIN
	IF n.id IS NULL THEN RETURN 0; END IF;
	base := jsonb_build_object('shop', n.shop_id, 'staff', n.staff_id, 'customer', n.customer_id, 'entity', 'call', 'entity_id', n.id, 'backfill', backfill, 'channel', 'phone',
		'props', jsonb_build_object('kind', n.kind, 'operator', nullif(n.operator, false), 'choice', n.operator_choice, 'auto_text', nullif(n.auto_text_sent, false), 'outreach', n.outreach_id));
	at := CASE WHEN backfill OR o IS NULL THEN coalesce(n.ended_at, n.created_at) ELSE clock_timestamp() END;
	IF o IS NULL THEN
		PERFORM "analytics_emit"(base || jsonb_build_object('event', CASE WHEN n.direction = 'in' THEN 'call.received' ELSE 'call.placed' END, 'key', 'call:' || n.id, 'at', n.created_at,
			'actor_kind', CASE WHEN n.direction = 'in' THEN 'client' END, 'subtype', n.kind));
	END IF;
	IF o IS NULL OR o.status IS DISTINCT FROM n.status THEN
		IF n.status = 'answered' OR (n.status = 'completed' AND n.direction = 'in' AND (o IS NULL OR o.status <> 'answered')) THEN
			PERFORM "analytics_emit"(base || jsonb_build_object('event', 'call.answered', 'key', 'call.answered:' || n.id, 'at', CASE WHEN n.status = 'answered' THEN at ELSE n.created_at END, 'subtype', n.kind,
				'minutes', "analytics_minutes"(n.created_at, CASE WHEN n.status = 'answered' THEN at ELSE n.created_at END)));
		END IF;
		IF n.status = 'completed' THEN
			PERFORM "analytics_emit"(base || jsonb_build_object('event', 'call.completed', 'key', 'call.completed:' || n.id, 'at', at, 'subtype', n.kind, 'minutes', n.duration_sec / 60.0));
		ELSIF n.status IN ('missed', 'after_hours', 'voicemail', 'no_answer', 'busy', 'failed') THEN
			PERFORM "analytics_emit"(base || jsonb_build_object('event', 'call.missed', 'key', 'call.missed:' || n.id, 'at', at, 'subtype', n.status, 'minutes', n.duration_sec / 60.0));
		END IF;
	END IF;
	RETURN 1;
END $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "analytics_customers"(n "customers", o "customers", backfill boolean) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
	src text;
BEGIN
	IF n.id IS NULL THEN RETURN 0; END IF;
	src := "analytics_safe_source"(n.source);
	IF o IS NULL THEN
		PERFORM "analytics_emit"(jsonb_build_object('event', 'client.created', 'key', 'client.created:' || n.id, 'at', n.created_at, 'backfill', backfill,
			'shop', n.home_shop_id, 'customer', n.id, 'entity', 'client', 'entity_id', n.id, 'source', src,
			'subtype', CASE WHEN n.referred_by_id IS NOT NULL THEN 'referred' WHEN n.guardian_id IS NOT NULL THEN 'dependent' END,
			'props', jsonb_build_object('referred', CASE WHEN n.referred_by_id IS NOT NULL THEN true END, 'dependent', CASE WHEN n.guardian_id IS NOT NULL THEN true END)));
	ELSIF src IS DISTINCT FROM "analytics_safe_source"(o.source) OR (n.referred_by_id IS NULL) <> (o.referred_by_id IS NULL) THEN
		PERFORM "analytics_emit"(jsonb_build_object('event', 'client.source_set', 'key', 'client.source_set:' || n.id || ':' || "analytics_epoch"(clock_timestamp()),
			'shop', n.home_shop_id, 'customer', n.id, 'entity', 'client', 'entity_id', n.id, 'source', src, 'subtype', CASE WHEN n.referred_by_id IS NOT NULL THEN 'referred' END));
	END IF;
	RETURN 1;
END $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "analytics_waitlist_entries"(n "waitlist_entries", o "waitlist_entries", backfill boolean) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
	base jsonb;
	at timestamptz;
BEGIN
	IF n.id IS NULL THEN RETURN 0; END IF;
	base := jsonb_build_object('shop', n.shop_id, 'customer', n.customer_id, 'staff', n.preferred_staff_id, 'entity', 'walkin', 'entity_id', n.id, 'appointment', n.appointment_id,
		'backfill', backfill, 'channel', 'walk_in', 'value', n.quoted_wait_min, 'props', jsonb_build_object('service', n.service_id, 'preferred', CASE WHEN n.preferred_staff_id IS NOT NULL THEN true END));
	IF o IS NULL THEN
		PERFORM "analytics_emit"(base || jsonb_build_object('event', 'walkin.joined', 'key', 'walkin.joined:' || n.id, 'at', n.joined_at));
	END IF;
	IF n.status <> 'waiting' AND (o IS NULL OR o.status IS DISTINCT FROM n.status) THEN
		at := CASE WHEN backfill OR o IS NULL THEN n.updated_at ELSE clock_timestamp() END;
		PERFORM "analytics_emit"(base || jsonb_build_object('event', 'walkin.' || n.status, 'key', 'walkin.' || n.status || ':' || n.id, 'at', at, 'minutes', "analytics_minutes"(n.joined_at, at)));
	END IF;
	RETURN 1;
END $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "analytics_visit_satisfaction"(n "visit_satisfaction", o "visit_satisfaction", backfill boolean) RETURNS integer LANGUAGE plpgsql AS $$
BEGIN
	IF n.id IS NULL OR NOT (o IS NULL) THEN RETURN 0; END IF;
	PERFORM "analytics_emit"(jsonb_build_object('event', 'visit.satisfaction', 'key', 'visit.satisfaction:' || n.id, 'at', n.created_at, 'backfill', backfill, 'actor_kind', 'client',
		'shop', n.shop_id, 'staff', n.staff_id, 'customer', n.customer_id, 'entity', 'ticket', 'entity_id', n.sale_id, 'sale', n.sale_id,
		'appointment', (SELECT "appointment_id" FROM "sales" WHERE "id" = n.sale_id), 'channel', n.channel, 'subtype', n.channel, 'value', n.stars));
	RETURN 1;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "appointments_analytics" ON "appointments";--> statement-breakpoint
CREATE TRIGGER "appointments_analytics" AFTER INSERT OR UPDATE OF "status", "starts_at", "staff_id" ON "appointments" FOR EACH ROW EXECUTE FUNCTION "analytics_capture"();--> statement-breakpoint
DROP TRIGGER IF EXISTS "appointment_times_analytics" ON "appointment_times";--> statement-breakpoint
CREATE TRIGGER "appointment_times_analytics" AFTER INSERT OR UPDATE OF "arrived_at", "started_at", "finished_at", "corrected_at" ON "appointment_times" FOR EACH ROW EXECUTE FUNCTION "analytics_capture"();--> statement-breakpoint
DROP TRIGGER IF EXISTS "sales_analytics" ON "sales";--> statement-breakpoint
CREATE TRIGGER "sales_analytics" AFTER INSERT OR UPDATE OF "status", "paid_at", "discount_cents", "staff_id", "voided_at", "merged_into_sale_id" ON "sales" FOR EACH ROW EXECUTE FUNCTION "analytics_capture"();--> statement-breakpoint
DROP TRIGGER IF EXISTS "sale_items_analytics" ON "sale_items";--> statement-breakpoint
CREATE TRIGGER "sale_items_analytics" AFTER INSERT ON "sale_items" FOR EACH ROW EXECUTE FUNCTION "analytics_capture"();--> statement-breakpoint
DROP TRIGGER IF EXISTS "refunds_analytics" ON "refunds";--> statement-breakpoint
CREATE TRIGGER "refunds_analytics" AFTER INSERT ON "refunds" FOR EACH ROW EXECUTE FUNCTION "analytics_capture"();--> statement-breakpoint
DROP TRIGGER IF EXISTS "payments_analytics" ON "payments";--> statement-breakpoint
CREATE TRIGGER "payments_analytics" AFTER INSERT OR UPDATE OF "status" ON "payments" FOR EACH ROW EXECUTE FUNCTION "analytics_capture"();--> statement-breakpoint
DROP TRIGGER IF EXISTS "coupon_redemptions_analytics" ON "coupon_redemptions";--> statement-breakpoint
CREATE TRIGGER "coupon_redemptions_analytics" AFTER INSERT OR UPDATE OF "reversed_at" ON "coupon_redemptions" FOR EACH ROW EXECUTE FUNCTION "analytics_capture"();--> statement-breakpoint
DROP TRIGGER IF EXISTS "inventory_ledger_analytics" ON "inventory_ledger";--> statement-breakpoint
CREATE TRIGGER "inventory_ledger_analytics" AFTER INSERT ON "inventory_ledger" FOR EACH ROW EXECUTE FUNCTION "analytics_capture"();--> statement-breakpoint
DROP TRIGGER IF EXISTS "time_punches_analytics" ON "time_punches";--> statement-breakpoint
CREATE TRIGGER "time_punches_analytics" AFTER INSERT OR UPDATE OF "edited_at", "voided_at" ON "time_punches" FOR EACH ROW EXECUTE FUNCTION "analytics_capture"();--> statement-breakpoint
DROP TRIGGER IF EXISTS "time_blocks_analytics" ON "time_blocks";--> statement-breakpoint
CREATE TRIGGER "time_blocks_analytics" AFTER INSERT OR DELETE ON "time_blocks" FOR EACH ROW EXECUTE FUNCTION "analytics_capture"();--> statement-breakpoint
DROP TRIGGER IF EXISTS "time_off_requests_analytics" ON "time_off_requests";--> statement-breakpoint
CREATE TRIGGER "time_off_requests_analytics" AFTER INSERT OR UPDATE OF "status" ON "time_off_requests" FOR EACH ROW EXECUTE FUNCTION "analytics_capture"();--> statement-breakpoint
DROP TRIGGER IF EXISTS "call_ins_analytics" ON "call_ins";--> statement-breakpoint
CREATE TRIGGER "call_ins_analytics" AFTER INSERT OR UPDATE OF "cancelled_at" ON "call_ins" FOR EACH ROW EXECUTE FUNCTION "analytics_capture"();--> statement-breakpoint
DROP TRIGGER IF EXISTS "notification_jobs_analytics" ON "notification_jobs";--> statement-breakpoint
CREATE TRIGGER "notification_jobs_analytics" AFTER INSERT OR UPDATE OF "status", "delivered_at" ON "notification_jobs" FOR EACH ROW EXECUTE FUNCTION "analytics_capture"();--> statement-breakpoint
DROP TRIGGER IF EXISTS "marketing_sends_analytics" ON "marketing_sends";--> statement-breakpoint
CREATE TRIGGER "marketing_sends_analytics" AFTER INSERT OR UPDATE OF "first_click_at" ON "marketing_sends" FOR EACH ROW EXECUTE FUNCTION "analytics_capture"();--> statement-breakpoint
DROP TRIGGER IF EXISTS "review_clicks_analytics" ON "review_clicks";--> statement-breakpoint
CREATE TRIGGER "review_clicks_analytics" AFTER INSERT ON "review_clicks" FOR EACH ROW EXECUTE FUNCTION "analytics_capture"();--> statement-breakpoint
DROP TRIGGER IF EXISTS "client_badges_analytics" ON "client_badges";--> statement-breakpoint
CREATE TRIGGER "client_badges_analytics" AFTER INSERT OR UPDATE OF "keys" ON "client_badges" FOR EACH ROW EXECUTE FUNCTION "analytics_capture"();--> statement-breakpoint
DROP TRIGGER IF EXISTS "assistant_messages_analytics" ON "assistant_messages";--> statement-breakpoint
CREATE TRIGGER "assistant_messages_analytics" AFTER INSERT ON "assistant_messages" FOR EACH ROW EXECUTE FUNCTION "analytics_capture"();--> statement-breakpoint
DROP TRIGGER IF EXISTS "call_logs_analytics" ON "call_logs";--> statement-breakpoint
CREATE TRIGGER "call_logs_analytics" AFTER INSERT OR UPDATE OF "status" ON "call_logs" FOR EACH ROW EXECUTE FUNCTION "analytics_capture"();--> statement-breakpoint
DROP TRIGGER IF EXISTS "customers_analytics" ON "customers";--> statement-breakpoint
CREATE TRIGGER "customers_analytics" AFTER INSERT OR UPDATE OF "source", "referred_by_id" ON "customers" FOR EACH ROW EXECUTE FUNCTION "analytics_capture"();--> statement-breakpoint
DROP TRIGGER IF EXISTS "waitlist_entries_analytics" ON "waitlist_entries";--> statement-breakpoint
CREATE TRIGGER "waitlist_entries_analytics" AFTER INSERT OR UPDATE OF "status" ON "waitlist_entries" FOR EACH ROW EXECUTE FUNCTION "analytics_capture"();--> statement-breakpoint
DROP TRIGGER IF EXISTS "visit_satisfaction_analytics" ON "visit_satisfaction";--> statement-breakpoint
CREATE TRIGGER "visit_satisfaction_analytics" AFTER INSERT ON "visit_satisfaction" FOR EACH ROW EXECUTE FUNCTION "analytics_capture"();--> statement-breakpoint
-- Erasing a client keeps the counts but drops who it was. A merge moves their events to the kept record first, so nothing is lost there.
CREATE OR REPLACE FUNCTION "analytics_forget"(c uuid) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
	n integer;
BEGIN
	UPDATE "analytics_events" SET "customer_id" = NULL WHERE "customer_id" = c;
	GET DIAGNOSTICS n = ROW_COUNT;
	RETURN n;
END $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "analytics_customer_removed"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
	n integer := "analytics_forget"(OLD."id");
BEGIN
	IF n > 0 THEN
		PERFORM "analytics_emit"(jsonb_build_object('event', 'client.removed', 'shop', OLD."home_shop_id", 'entity', 'client', 'quantity', n));
	END IF;
	RETURN NULL;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "customers_analytics_forget" ON "customers";--> statement-breakpoint
CREATE TRIGGER "customers_analytics_forget" AFTER DELETE ON "customers" FOR EACH ROW EXECUTE FUNCTION "analytics_customer_removed"();--> statement-breakpoint
-- Logs the history already on file, one source table at a time, through the same functions the triggers use (flagged backfilled). Safe to run again: rows already logged are skipped. Run by scripts/analytics-backfill.ts and the nightly job, not by this migration.
CREATE OR REPLACE FUNCTION "analytics_backfill"(what text) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE
	before bigint;
	after bigint;
BEGIN
	IF what NOT IN ('customers', 'appointments', 'appointment_times', 'sales', 'sale_items', 'refunds', 'payments', 'coupon_redemptions', 'inventory_ledger', 'time_punches', 'time_blocks',
		'time_off_requests', 'call_ins', 'notification_jobs', 'marketing_sends', 'review_clicks', 'client_badges', 'assistant_messages', 'call_logs', 'waitlist_entries', 'visit_satisfaction') THEN
		RAISE EXCEPTION 'No event backfill for %', what USING ERRCODE = 'invalid_parameter_value';
	END IF;
	SELECT coalesce(max("id"), 0) INTO before FROM "analytics_events";
	EXECUTE format('SELECT sum(%I(t, NULL::%I, true)) FROM %I t', 'analytics_' || what, what, what);
	SELECT count(*) INTO after FROM "analytics_events" WHERE "id" > before AND ("props"->>'backfilled')::boolean;
	RETURN after;
END $$;--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" || '["report.operations.view"]'::jsonb WHERE "permissions" ? 'report.kpis.view' AND NOT ("permissions" ? 'report.operations.view');--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" || '["report.operations.export"]'::jsonb WHERE "permissions" ? 'report.kpis.export' AND NOT ("permissions" ? 'report.operations.export');--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" || '["analytics.events", "analytics.settings"]'::jsonb WHERE "key" = 'brand_admin' AND NOT ("permissions" ? 'analytics.events');
