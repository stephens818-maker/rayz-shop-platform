/**
 * Processor-hosted data: card numbers, bank details, SSNs, EINs, birth dates for identity checks
 * and ID documents stay with Stripe. Plants them everywhere they could arrive (Stripe webhooks for
 * an employee's and a shop's account, client notes, an inbound text, a Squire import, a queued
 * message, the audit log, a server action's error) and then greps every table, the logs and every
 * customer-facing API response for them.
 */
import Stripe from "stripe";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { REMOVED, findSensitive, installLogScrubbing, isForbiddenKey, scrub, scrubText } from "@/lib/sensitive";
import { Mods, actor, loadModules } from "./setup";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));

let m: Mods;
let accounts: typeof import("@/server/tips/accounts");
let connectWebhook: typeof import("@/server/payments/connect-webhook");
const logged: string[] = [];
const originalConsole = { ...console };

/** Every value planted below. None may be stored, logged or returned. */
const PLANTED = ["110000000", "000123456789", "987654321", "4000 0566 5566 5556", "4000056655665556", "4242424242424242", "123-45-6789", "12-3456789"];
const PLANTED_RE = new RegExp(`${PLANTED.map((p) => p.replace(/[ -]/g, "[ -]?")).join("|")}|year\\W{0,4}1901`);

beforeAll(async () => {
  m = await loadModules();
  accounts = await import("@/server/tips/accounts");
  connectWebhook = await import("@/server/payments/connect-webhook");
  for (const k of ["log", "info", "warn", "error", "debug"] as const) console[k] = (...a: unknown[]) => void logged.push(a.map((x) => (x instanceof Error ? `${x.message}\n${x.stack}` : typeof x === "string" ? x : JSON.stringify(x))).join(" "));
  installLogScrubbing();
}, 180_000);

afterAll(async () => {
  Object.assign(console, originalConsole);
  await m?.db.closeDb();
});

const sql = (...a: Parameters<Mods["drizzle"]["sql"]>) => m.drizzle.sql(...a);
const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);
const rows = async <T,>(q: ReturnType<typeof sql>) => (await m.db.db.execute(q)) as unknown as T[];

/** The shop's customer number at a supplier, printed on purchase orders; not a bank account. */
const ALLOWED_COLUMNS = new Set(["vendors.account_number", "shop_vendors.account_number"]);
const FREE_TEXT = /(^|_)(note|notes|reason|body|subject|detail|details|errors|custom_fields|message)$/;

describe("the database has nowhere to keep them", () => {
  it("no live column is a card, bank, SSN, TIN, EIN, birth date or ID document field", async () => {
    const cols = await rows<{ c: string }>(sql`select table_name || '.' || column_name c from information_schema.columns where table_schema = 'public'`);
    expect(cols.length).toBeGreaterThan(500);
    expect(cols.map((r) => r.c).filter((c) => isForbiddenKey(c.split(".")[1]) && !ALLOWED_COLUMNS.has(c))).toEqual([]);
  });

  it("every free-text column (notes, reasons, bodies, details, errors, custom fields) is scrubbed by a trigger", async () => {
    const free = await rows<{ t: string; c: string }>(
      sql`select table_name t, column_name c from information_schema.columns where table_schema = 'public' and data_type in ('text', 'jsonb') and column_name ~ ${FREE_TEXT.source}`,
    );
    expect(free.length).toBeGreaterThan(40);
    const defs = await rows<{ t: string; def: string }>(sql`select tgrelid::regclass::text t, pg_get_triggerdef(oid) def from pg_trigger where tgname like '%\_scrub\_sensitive' and not tgisinternal`);
    const covered = new Set(defs.flatMap((d) => [...d.def.matchAll(/'(\w+)'/g)].map((a) => `${d.t}.${a[1]}`)));
    expect(free.map((f) => `${f.t}.${f.c}`).filter((c) => !covered.has(c))).toEqual([]);
    expect(covered).toContain("time_punch_edits.before");
    expect(covered).toContain("time_punch_edits.after");
  });

  it("the database's rules match the app's", async () => {
    const samples = [
      "card 4242424242424242 ok",
      "4000 0566 5566 5556",
      "5555-5555-5555-4444.",
      "amex 3782 822463 10005",
      "SSN 123-45-6789, alt 123 45 6789",
      "EIN: 12-3456789",
      "order 4000056655665557 at 1792860000000",
      "gift card AB2C-3456-7892-3456, +13195550188, 2026-10-23",
      "pi_4242424242424242 x-12-3456789 123-45 6789",
      "gps 41.5602, -91.53012345678901234, ratio 0.4242424242424242, card 4242424242424242.",
      "no digits",
    ];
    for (const s of samples) {
      const [r] = await rows<{ out: string }>(sql`select scrub_sensitive_text(${s}) out`);
      expect(r.out, s).toBe(scrubText(s));
    }
    const doc = {
      routingNumber: "110000000",
      bank: { account_number: "000123456789", last4: "6789", bank_name: "STRIPE TEST BANK" },
      "Tax ID": "12-3456789",
      individual: { dob: { day: 1, month: 1, year: 1901 }, id_number: "987654321", ssn_last_4: "6789" },
      list: ["4242 4242 4242 4242", 5, 4242424242424242, { cvc: "123" }],
      birthday: "1990-07-14",
      note: "SSN 123-45-6789",
    };
    const [r] = await rows<{ out: unknown }>(sql`select scrub_sensitive_jsonb(${JSON.stringify(doc)}::jsonb) out`);
    expect(r.out).toEqual(scrub(doc));
  });
});

describe("planted everywhere, found nowhere", () => {
  const secret = "whsec_test_sensitive";
  const connectEvent = (type: string, object: object, account: string) => {
    const payload = JSON.stringify({ id: `evt_${Math.random().toString(36).slice(2)}`, object: "event", type, account, data: { object } });
    return connectWebhook.handleConnectWebhook(payload, Stripe.webhooks.generateTestHeaderString({ payload, secret }), secret);
  };
  const bank = { id: "ba_test_sensitive", object: "bank_account", bank_name: "STRIPE TEST BANK", last4: "6789", routing_number: "110000000", account_number: "000123456789", fingerprint: "fp_x", default_for_currency: true };
  const card = { id: "card_test_sensitive", object: "card", brand: "Visa", last4: "5556", number: "4000056655665556", cvc: "123", exp_month: 12, exp_year: 2030, fingerprint: "fp_y", default_for_currency: true };
  const person = { ssn_last_4: "6789", id_number: "987654321", dob: { day: 1, month: 1, year: 1901 }, first_name: "Planted", verification: { document: { front: "file_test_front" } } };
  const responses: string[] = [];
  let staffId: string;
  let shopId: string;
  let customerId: string;
  let token: string;

  beforeAll(async () => {
    const [sa] = await rows<{ staff_id: string; stripe_account_id: string }>(sql`select staff_id, stripe_account_id from staff_payout_accounts where stripe_account_id is not null limit 1`);
    staffId = sa.staff_id;
    const shop = (await m.catalog.getShop("coralville"))!;
    shopId = shop.id;
    const shopAcct = (await m.db.db.query.shopPaymentAccounts.findFirst({ where: eq(m.schema.shopPaymentAccounts.shopId, shopId) }))!;

    const send = async (type: string, object: object, account: string) => {
      const r = await connectEvent(type, object, account);
      expect(r.status, `${type}: ${r.body}`).toBe(200);
      responses.push(JSON.stringify(r));
    };
    const requirements = { currently_due: ["individual.ssn_last_4", "external_account"], past_due: [], pending_verification: ["individual.id_number"], disabled_reason: "requirements.past_due 123-45-6789", current_deadline: null };
    await send("account.updated", { id: sa.stripe_account_id, object: "account", payouts_enabled: true, details_submitted: true, individual: person, requirements, external_accounts: { object: "list", data: [bank] } }, sa.stripe_account_id);
    await send("account.external_account.created", card, sa.stripe_account_id);
    await send("account.external_account.updated", bank, sa.stripe_account_id);
    await send(
      "account.updated",
      {
        id: shopAcct.stripeAccountId,
        object: "account",
        charges_enabled: true,
        payouts_enabled: true,
        details_submitted: true,
        company: { name: "Planted LLC", tax_id: "12-3456789", tax_id_provided: true },
        individual: person,
        requirements,
        external_accounts: { object: "list", data: [bank] },
      },
      shopAcct.stripeAccountId,
    );
    await send(
      "payout.failed",
      { id: "po_test_sensitive", object: "payout", amount: 1000, currency: "usd", status: "failed", arrival_date: Math.floor(Date.now() / 1000), failure_code: "account_closed", failure_message: "Account for card 4000 0566 5566 5556 closed", destination: bank },
      shopAcct.stripeAccountId,
    );

    const [c] = await m.db.db
      .insert(m.schema.customers)
      .values({ firstName: "Planted", lastName: "Client", phone: "+13195550177", notes: "Paid with 4000 0566 5566 5556, SSN 123-45-6789", customFields: { a: "EIN 12-3456789", b: "4242424242424242" } })
      .returning();
    customerId = c.id;
    await m.db.db.update(m.schema.customers).set({ notes: "Updated: card 4242 4242 4242 4242" }).where(eq(m.schema.customers.id, customerId));
    token = (await m.auth.issueTokens(customerId, null)).accessToken;

    const line = await import("@/server/shop-line");
    await line.handleInboundSms({ from: "+13195550177", to: shop.twilioNumber!, body: "my card is 4000 0566 5566 5556 and ssn 123-45-6789", messageSid: "SM_test_sensitive" });

    await m.importer.runImport(
      "clients",
      [
        "Client ID,First Name,Last Name,Phone,Email,Location,SMS Opt In,Email Marketing,Notes,SSN,Routing Number,Card Number",
        "sq_sensitive_1,Imported,Client,(319) 555-0166,,Coralville,No,No,Card 4242 4242 4242 4242 on file,123-45-6789,110000000,4000056655665556",
        "sq_sensitive_2,,,(319) 555-0167,,Coralville,No,No,EIN 12-3456789,123-45-6789,110000000,4000056655665556",
      ].join("\n"),
      { dryRun: false, actor, filename: "planted.csv" },
    );

    await m.queue.enqueueRaw({ kind: "tip_banking", channel: "sms", to: "+13195550177", body: "Card 4242424242424242 ready", subject: "SSN 123-45-6789", shopId });
    await m.queue.processDueJobs();

    const { audit } = await import("@/server/audit");
    await audit(actor, "test.planted", "test", null, { note: "card 4000 0566 5566 5556", routingNumber: "110000000", nested: [{ ssn: "123456789", taxId: "12-3456789" }] }, shopId);

    const { safe } = await import("@/server/action");
    const failed = await safe(async () => {
      throw Object.assign(new Error("Stripe said card 4242424242424242 was declined"), { raw: { routing_number: "110000000", ssn: "123-45-6789" } });
    });
    expect(failed).toEqual({ ok: false, error: "Something went wrong. Please try again." });
  }, 120_000);

  it("the values really arrived: Stripe's statuses, last 4 and bank names are kept, the rest became markers", async () => {
    const acct = (await accounts.staffAccount(staffId))!;
    expect(acct).toMatchObject({ payoutsEnabled: true, destinationLast4: "6789", destinationName: "STRIPE TEST BANK" });
    const c = (await m.db.db.query.customers.findFirst({ where: eq(m.schema.customers.id, customerId) }))!;
    expect(c.notes).toBe(`Updated: card ${REMOVED.card}`);
    expect(c.customFields).toEqual({ a: `EIN ${REMOVED.ein}`, b: REMOVED.card });
    const [inbound] = await rows<{ body: string }>(sql`select body from messages where provider_message_id = 'SM_test_sensitive'`);
    expect(inbound.body).toBe(`my card is ${REMOVED.card} and ssn ${REMOVED.ssn}`);
    const [run] = await rows<{ errors: { data?: Record<string, string> }[] }>(sql`select errors from import_runs where filename = 'planted.csv'`);
    expect(run.errors[0].data).toMatchObject({ SSN: REMOVED.key, "Routing Number": REMOVED.key, "Card Number": REMOVED.key, Notes: `EIN ${REMOVED.ein}` });
    const [planted] = await rows<{ details: unknown }>(sql`select details from audit_log where action = 'test.planted'`);
    expect(planted.details).toEqual({ note: `card ${REMOVED.card}`, routingNumber: REMOVED.key, nested: [{ ssn: REMOVED.key, taxId: REMOVED.key }] });
    expect(logged.join("\n")).toMatch(/Stripe said card \[card number removed\] was declined/);
  });

  it("no table holds a planted value or any card, SSN or EIN number", async () => {
    const tables = await rows<{ t: string }>(sql`select table_name t from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by 1`);
    expect(tables.length).toBeGreaterThan(80);
    const hits: string[] = [];
    let scanned = 0;
    for (const { t } of tables) {
      const all = await rows<{ r: string }>(sql`select x::text r from ${m.drizzle.sql.identifier(t)} x`);
      scanned += all.length;
      all.forEach((x, i) => {
        if (PLANTED_RE.test(x.r)) hits.push(`${t}[${i}] planted: ${x.r.slice(0, 160)}`);
        for (const f of findSensitive(x.r)) hits.push(`${t}[${i}] ${f.why}: ${x.r.slice(0, 160)}`);
      });
    }
    expect(scanned).toBeGreaterThan(1000);
    expect(hits).toEqual([]);
  });

  it("no JSON column holds a card, bank, SSN or EIN field", async () => {
    const cols = await rows<{ t: string; c: string }>(sql`select table_name t, column_name c from information_schema.columns where table_schema = 'public' and data_type = 'jsonb'`);
    const hits: string[] = [];
    for (const { t, c } of cols) {
      const vals = await rows<{ v: unknown }>(sql`select ${m.drizzle.sql.identifier(c)} v from ${m.drizzle.sql.identifier(t)} where ${m.drizzle.sql.identifier(c)} is not null`);
      for (const { v } of vals) for (const f of findSensitive(v)) if (!(f.why === "forbidden key" && JSON.stringify(v).includes(`"${f.path.split(".").pop()}":"[removed]"`))) hits.push(`${t}.${c} ${f.path} ${f.why}`);
    }
    expect(hits).toEqual([]);
  });

  it("nothing logged carries them", () => {
    expect(logged.length).toBeGreaterThan(0);
    expect(logged.filter((l) => PLANTED_RE.test(l) || findSensitive(l).length)).toEqual([]);
  });

  it("webhook responses, the managers' and employee's banking views carry only status, last 4 and names", async () => {
    const payloads = [
      ...responses,
      JSON.stringify(await accounts.staffAccount(staffId)),
      JSON.stringify(await accounts.payoutAccountSummaries([staffId])),
      JSON.stringify(await accounts.shopPayoutAccounts(shopId)),
      JSON.stringify(await accounts.bankingActivity(staffId, 50)),
    ];
    for (const p of payloads) {
      expect(p).not.toMatch(PLANTED_RE);
      expect(findSensitive(JSON.parse(p)), p.slice(0, 200)).toEqual([]);
    }
    expect(payloads.join()).toMatch(/6789/);
  });

  function routeFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((f) => {
      const p = path.join(dir, f);
      return statSync(p).isDirectory() ? routeFiles(p) : f === "route.ts" ? [p] : [];
    });
  }

  it("no GET under /api/v1, the signed-in client's profile or the OpenAPI document has a forbidden field or value", async () => {
    const svc = (await m.public.publicServices("coralville")).services[0];
    const date = m.time.addDays(m.time.todayLocal(), 5);
    const root = path.resolve(__dirname, "../../src/app/api/v1");
    const [appt] = await rows<{ code: string }>(sql`select code from appointments where customer_id is not null limit 1`);
    const params: Record<string, string> = { shop: "coralville", code: appt.code };
    let checked = 0;
    for (const file of routeFiles(root)) {
      const mod = (await import(file)) as { GET?: (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response> };
      if (!mod.GET) continue;
      const rel = path.relative(root, path.dirname(file));
      const p: Record<string, string> = {};
      const urlPath = (rel ? rel.split(path.sep) : []).map((s) => {
        const k = s.match(/^\[(.+)\]$/)?.[1];
        if (!k) return s;
        p[k] = params[k];
        return p[k];
      });
      const url = new URL(`http://localhost/api/v1/${urlPath.join("/")}`);
      url.search = new URLSearchParams({ date, from: date, serviceId: svc.id, days: "7" }).toString();
      const res = await mod.GET(new Request(url, { headers: { authorization: `Bearer ${token}` } }), { params: Promise.resolve(p) });
      const text = await res.text();
      expect(res.status, `${rel}: ${text.slice(0, 200)}`).toBeLessThan(500);
      expect(text, rel).not.toMatch(PLANTED_RE);
      expect(findSensitive(text.startsWith("{") || text.startsWith("[") ? JSON.parse(text) : text), rel).toEqual([]);
      checked++;
    }
    expect(checked).toBeGreaterThanOrEqual(10);
    const { openApiDocument } = await import("@/server/openapi");
    for (const p of [await m.public.publicMe(customerId), await m.public.myAppointments(customerId), openApiDocument("http://localhost")]) {
      expect(JSON.stringify(p)).not.toMatch(PLANTED_RE);
      expect(findSensitive(p)).toEqual([]);
    }
  });
});
