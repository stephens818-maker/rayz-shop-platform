/**
 * The owner's rule: shop logins and shop and staff roles don't see a client's full phone, email or
 * address, and don't export or download client lists, unless the brand gives a person or a location
 * contact access (contact-grants.test.ts). Without a grant it isn't just a default: every
 * non-brand-level login here is given full rules and every client-list permission straight in the
 * database, and still gets contact details masked, every download refused and every reveal of them
 * refused, while exact search and calls and texts through the shop line keep working. No role, rule
 * or override can give it to a shop or staff role, not even the Brand Owner's. Only brand-level
 * people (the Brand Owner, Brand Admins and brand-level roles the Brand Owner creates, with every
 * shop) see contact details in full and export without a grant.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { brandAction, fieldRule } from "./brand";
import { Mods, loadModules } from "./setup";
import { found, get, open } from "./render";
import { signInAs } from "./session";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));

let m: Mods;
const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);

const P = { first: "Lucia", last: "Lockdownova", phone: "+13195554417", email: "lucia.lockdown@example.test", address: "77 Quiet Street, Coralville, IA 52241" };
const RAW = ["+13195554417", "3195554417", "5554417", "555-4417", "lucia.lockdown@", "77 Quiet Street"];
const MASKED_PHONE = "***-***-4417";

const LOGINS = ["owner", "admin", "frontdesk", "michelle", "makenna", "regional", "kat", "coralville"] as const;
type Login = (typeof LOGINS)[number];
const SHOP_LEVEL = ["coralville", "michelle", "frontdesk", "makenna", "regional", "kat"] as const;
const people = {} as Record<Login, string>;
const ids = {} as { client: string; coralville: string; importRun: string; analyst: string };
const as = (l: Login) => signInAs(people[l]);
const ctx = async () => (await (await import("@/server/auth/staff")).getStaffContext())!;
const policy = async () => (await import("@/server/client-privacy")).clientPolicy(await ctx());

/** Every client-list download, with what it needs to be asked for. */
const downloads = async (): Promise<[string, (req: Request, c?: unknown) => Promise<Response>, string, Record<string, string>?][]> => [
  ["client list", (await import("@/app/admin/customers/export/route")).GET as never, "/admin/customers/export"],
  ["Campaign Center contacts", (await import("@/app/admin/campaign-center/export/route")).GET as never, "/admin/campaign-center/export"],
  ["client ratings", (await import("@/app/admin/reports/ratings/export/route")).GET as never, "/admin/reports/ratings/export?period=all"],
  ["import skipped rows", (await import("@/app/admin/import/[runId]/errors/route")).GET as never, `/admin/import/${ids.importRun}/errors`, { runId: ids.importRun }],
  ["client data access log", (await import("@/app/admin/client-data/access/export/route")).GET as never, "/admin/client-data/access/export?days=30"],
];

beforeAll(async () => {
  m = await loadModules();
  for (const l of LOGINS) people[l] = (await m.db.db.query.staff.findFirst({ where: eq(m.schema.staff.email, `${l}@rayz.test`) }))!.id;
  ids.coralville = (await m.db.db.query.shops.findFirst({ where: eq(m.schema.shops.slug, "coralville") }))!.id;
  const [c] = await m.db.db
    .insert(m.schema.customers)
    .values({ firstName: P.first, lastName: P.last, phone: P.phone, email: P.email, address: P.address, homeShopId: ids.coralville, smsOptIn: true, emailOptIn: true })
    .returning();
  ids.client = c.id;
  const at = m.time.zonedWallTime(m.time.addDays(m.time.todayLocal(), -2), 10 * 60).toJSDate();
  const [a] = await m.db.db
    .insert(m.schema.appointments)
    .values({ code: `L${crypto.randomUUID().slice(0, 7).toUpperCase()}`, shopId: ids.coralville, staffId: people.makenna, customerId: c.id, startsAt: at, endsAt: new Date(at.getTime() + 30 * 60_000), status: "completed", source: "staff", estimateCents: 2300, completedAt: new Date(at.getTime() + 30 * 60_000) })
    .returning();
  await m.db.db.insert(m.schema.clientRatings).values({ customerId: c.id, shopId: ids.coralville, appointmentId: a.id, staffId: people.makenna, stars: 2, note: "Lockdown rating" });

  // A client import with a skipped row, run by the owner.
  await as("owner");
  const { importAction } = await import("@/app/admin/import/actions");
  const run = await importAction({ kind: "clients", csv: `First Name,Last Name,Phone,Email\n,,${P.phone},${P.email}\n`, dryRun: false });
  ids.importRun = run.ok ? run.data.runId! : "";

  // Everything the actions refuse, written straight into the database: full contact rules for every
  // shop and staff role and person, and every client-list permission as an override.
  const roles = await m.db.db.select().from(m.schema.roles);
  const shopRoles = roles.filter((r) => r.key && !["brand_owner", "brand_admin"].includes(r.key));
  const rules = ["phone", "email", "address"].flatMap((field) => [
    ...shopRoles.map((r) => ({ field, setting: "view" as const, roleId: r.id, staffId: null, shopId: null, level: "full" as const })),
    ...SHOP_LEVEL.map((l) => ({ field, setting: "view" as const, roleId: null, staffId: people[l], shopId: null, level: "full" as const })),
  ]);
  await m.db.db.insert(m.schema.clientFieldRules).values(rules);
  const grants = Object.fromEntries(
    ["clients.contact_full", "clients.export", "campaign_center.export", "import.run", "clients.privacy", "clients.reveal", "clients.view_all", "report.client_ratings.view", "report.client_ratings.export"].map((p) => [p, true]),
  );
  for (const l of SHOP_LEVEL) await m.db.db.update(m.schema.staff).set({ permissionOverrides: grants }).where(eq(m.schema.staff.id, people[l]));
  for (const r of shopRoles) await m.db.db.update(m.schema.roles).set({ permissions: [...new Set([...r.permissions, ...Object.keys(grants)])] }).where(eq(m.schema.roles.id, r.id));
}, 180_000);

afterAll(async () => {
  await m?.db.closeDb();
});

describe("shop logins and shop and staff roles, given everything in the database", () => {
  for (const who of SHOP_LEVEL) {
    describe(who, () => {
      it("see phone, email and address masked at most, and can't reveal them", async () => {
        await as(who);
        const p = await policy();
        expect(p.fullContact).toBe(false);
        for (const f of ["phone", "email", "address"] as const) {
          expect(p.level(f), f).not.toBe("full");
          expect(p.mayReveal(f), f).toBe(false);
        }
        expect(found(String(p.show("phone", P.phone)), RAW)).toEqual([]);
        const { revealClientFieldAction } = await import("@/app/admin/customers/actions");
        for (const field of ["phone", "email", "address"]) {
          const r = await revealClientFieldAction({ customerId: ids.client, field, reason: "The client asked us to read it back" });
          expect(r.ok, `${who} reveals ${field}`).toBe(false);
          expect(found(JSON.stringify(r), RAW)).toEqual([]);
        }
      });

      it("never get the raw values on a page", async () => {
        await as(who);
        let opened = 0;
        for (const [route, params, sp] of [
          ["/admin/customers/[id]", { id: ids.client }, {}],
          ["/admin/customers", {}, { q: P.last }],
          ["/admin/calendar", {}, { shop: ids.coralville }],
        ] as const) {
          const r = await open(route, params, sp);
          if (r.kind !== "ok") continue;
          opened++;
          expect(found(r.text, RAW), route).toEqual([]);
          if (route === "/admin/customers/[id]") expect(r.text).toContain(MASKED_PHONE);
        }
        expect(opened, "pages opened").toBeGreaterThan(0);
      });

      it("are refused every client-list download", async () => {
        await as(who);
        for (const [name, handler, url, params] of await downloads()) {
          const r = await get(handler, url, params);
          expect(r.status, name).toBe(403);
          expect(found(r.text, RAW), name).toEqual([]);
        }
        const { exportDenied } = await import("@/server/report-builder/saved");
        const c = await ctx();
        expect(exportDenied({ ...c, permissions: new Set([...c.permissions, "report_builder.export", "clients.export"]) }, "customers")).toMatch(/brand-level roles/);
      });
    });
  }

  it("still find the client by the exact number or email they type, but not by part of it", async () => {
    const { searchCustomersAction } = await import("@/app/admin/calendar/actions");
    for (const who of ["coralville", "michelle", "frontdesk"] as const) {
      await as(who);
      for (const term of [P.phone, "(319) 555-4417", P.email]) {
        const r = await searchCustomersAction(term);
        expect(r.ok && r.data.map((x) => x.id), `${who} ${term}`).toContain(ids.client);
        expect(found(JSON.stringify(r), RAW), `${who} ${term}`).toEqual([]);
      }
      for (const term of ["5554417", "lucia.lockdown@ex"]) {
        const r = await searchCustomersAction(term);
        expect(r.ok && r.data.map((x) => x.id), `${who} ${term}`).not.toContain(ids.client);
      }
    }
  });

  it("text and call clients through the shop line: the real number is used, never returned", async () => {
    const { contactClientAction } = await import("@/app/admin/customers/actions");
    for (const who of ["coralville", "michelle"] as const) {
      await as(who);
      const r = await contactClientAction(ids.client, { channel: "sms", message: "Your barber is running 5 minutes behind" });
      expect(r, who).toMatchObject({ ok: true, data: { to: MASKED_PHONE } });
      expect(found(JSON.stringify(r), RAW)).toEqual([]);
    }
    const jobs = await m.db.db.select().from(m.schema.notificationJobs).where(eq(m.schema.notificationJobs.customerId, ids.client));
    expect(jobs.filter((j) => j.kind === "staff_text").map((j) => j.to)).toEqual([P.phone, P.phone]);
  });

  it("the audit log CSV leaves out client entries", async () => {
    const route = (await import("@/app/admin/reports/export/route")).GET;
    await m.db.db.insert(m.schema.auditLog).values({ actorLabel: "Owner", action: "customer.update", entity: "customer", entityId: ids.client, shopId: ids.coralville, details: { name: P.last } });
    await as("michelle");
    const r = await get(route as never, `/admin/reports/export?type=audit_log&shop=${ids.coralville}&preset=30d`);
    if (r.status === 200) expect(r.text).not.toContain(ids.client);
    await as("owner");
    expect((await get(route as never, `/admin/reports/export?type=audit_log&shop=${ids.coralville}&preset=30d`)).text).toContain(ids.client);
  });
});

describe("no role, rule or override gives it to a shop or staff role, not even the Brand Owner's", () => {
  it("full contact rules for a shop or staff role or person are refused", async () => {
    const manager = (await m.db.db.query.roles.findFirst({ where: eq(m.schema.roles.key, "shop_manager") }))!;
    for (const who of ["owner", "admin"] as const) {
      await as(who);
      for (const field of ["phone", "email", "address"]) {
        for (const target of [{ roleId: manager.id, staffId: null }, { roleId: null, staffId: people.michelle }, { roleId: null, staffId: people.coralville }])
          expect(await fieldRule({ field, level: "full", shopId: null, ...target }), `${who} ${field}`).toMatchObject({ ok: false, error: expect.stringMatching(/Give a person or a location contact access/) });
        expect(await fieldRule({ field, level: "masked", shopId: null, roleId: manager.id, staffId: null })).toMatchObject({ ok: true });
      }
    }
  });

  it("client-list permissions on a shop or staff role, or as an override, are refused", async () => {
    const { saveUserAccessAction } = await import("@/app/admin/permissions/actions");
    const manager = (await m.db.db.query.roles.findFirst({ where: eq(m.schema.roles.key, "shop_manager") }))!;
    const michelle = (await m.db.db.query.staff.findFirst({ where: eq(m.schema.staff.id, people.michelle) }))!;
    await as("owner");
    for (const p of ["clients.contact_full", "clients.export", "campaign_center.export", "report.client_ratings.export", "import.run", "clients.privacy"]) {
      const role = { id: manager.id, name: manager.name, description: manager.description, permissions: [...manager.permissions, p, "report.client_ratings.view"], maxDiscountPct: manager.maxDiscountPct, defaultScope: manager.defaultScope };
      expect(await brandAction("role", role.id, role), p).toMatchObject({ ok: false, error: expect.stringMatching(/only for brand-level roles|isn't part of a role/) });
      expect(await brandAction("role", role.id, { ...role, permissions: manager.permissions, brandLevel: true })).toMatchObject({ ok: false, error: expect.stringMatching(/Built-in roles can't be made brand-level/) });
      const access = { staffId: michelle.id, roleId: michelle.roleId, maxDiscountPct: null, scope: "one" as const, shopIds: [ids.coralville], overrides: { [p]: true } };
      expect(await saveUserAccessAction(access), p).toMatchObject({ ok: false, error: expect.stringMatching(/only for brand-level roles|isn't part of a role/) });
    }
    expect(await brandAction("setting", "shop_login_contact", "role")).toMatchObject({ ok: false });
  });

  it("only the Brand Owner makes a role brand-level", async () => {
    await as("admin");
    const r = await brandAction("role", crypto.randomUUID(), { name: "Admin's analyst", permissions: ["clients.view_all"], maxDiscountPct: 0, defaultScope: "all", brandLevel: true });
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/Only the Brand Owner/) });
  });
});

describe("brand-level people", () => {
  it("a brand-level role the Brand Owner creates sees contact details in full and exports, with every shop", async () => {
    const { saveUserAccessAction } = await import("@/app/admin/permissions/actions");
        await as("owner");
    const analyst = crypto.randomUUID();
    const created = await brandAction("role", analyst, { name: "Brand analyst", permissions: ["clients.view_all", "clients.export"], maxDiscountPct: 0, defaultScope: "all", brandLevel: true });
    expect(created).toMatchObject({ ok: true });
    ids.analyst = analyst;
    for (const field of ["phone", "email", "address"]) expect(await fieldRule({ field, level: "full", roleId: ids.analyst, staffId: null, shopId: null })).toMatchObject({ ok: true });
    await m.db.db.update(m.schema.staff).set({ permissionOverrides: {} }).where(eq(m.schema.staff.id, people.regional));
    const base = { staffId: people.regional, roleId: ids.analyst, maxDiscountPct: null, overrides: {}, shopRoles: {} };
    expect(await saveUserAccessAction({ ...base, scope: "all", shopIds: [] })).toMatchObject({ ok: true });

    await as("regional");
    const p = await policy();
    expect(p.fullContact).toBe(true);
    expect(p.show("phone", P.phone)).toBe("(319) 555-4417");
    const csv = await get((await import("@/app/admin/customers/export/route")).GET as never, "/admin/customers/export");
    expect(csv.status, csv.text).toBe(200);
    expect(csv.text).toContain(P.email);
    expect(csv.text).toContain("77 Quiet Street");

    // The same role with only some shops is a shop-level login again.
    await as("owner");
    expect(await saveUserAccessAction({ ...base, scope: "selected", shopIds: [ids.coralville] })).toMatchObject({ ok: true });
    await as("regional");
    expect((await policy()).level("phone")).toBe("masked");
    expect((await get((await import("@/app/admin/customers/export/route")).GET as never, "/admin/customers/export")).status).toBe(403);
  });

  it("a shop login under a brand-level role is still a shop login", async () => {
    await m.db.db.update(m.schema.staff).set({ roleId: ids.analyst, shopScope: "all" }).where(eq(m.schema.staff.id, people.coralville));
    await as("coralville");
    const p = await policy();
    expect(p.fullContact).toBe(false);
    expect(found(String(p.show("phone", P.phone)), RAW)).toEqual([]);
    for (const [name, handler, url, params] of await downloads()) expect((await get(handler, url, params)).status, name).toBe(403);
  });

  it("Brand Admins see contact details in full, and export once the Brand Owner grants it", async () => {
    const { saveUserAccessAction } = await import("@/app/admin/permissions/actions");
    await as("admin");
    const p = await policy();
    expect(p.fullContact).toBe(true);
    expect(p.level("phone")).toBe("full");
    const route = (await import("@/app/admin/customers/export/route")).GET as never;
    expect((await get(route, "/admin/customers/export")).status).toBe(403);
    await as("owner");
    const admin = (await m.db.db.query.staff.findFirst({ where: eq(m.schema.staff.id, people.admin) }))!;
    expect(await saveUserAccessAction({ staffId: admin.id, roleId: admin.roleId, maxDiscountPct: null, scope: "all", shopIds: [], overrides: { "clients.export": true } })).toMatchObject({
      ok: true,
    });
    await as("admin");
    const csv = await get(route, "/admin/customers/export");
    expect(csv.status).toBe(200);
    expect(csv.text).toContain(P.email);
  });
});
