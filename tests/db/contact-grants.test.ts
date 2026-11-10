/**
 * Contact access grants, end to end. Shop logins and staff see client contact details masked and
 * can't export by default; the brand gives full contact details or exporting, separately, to one
 * person or to everyone at one location, and can revoke either at any time. Every grant, revoke
 * and export is logged, and nobody gives what they don't have.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Mods, loadModules } from "./setup";
import { found, get, open } from "./render";
import { signInAs } from "./session";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));

let m: Mods;
const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);

const P = { first: "Greta", last: "Grantwell", phone: "+13195558812", email: "greta.grant@example.test", address: "12 Granted Lane, Coralville, IA 52241" };
const RAW = ["+13195558812", "3195558812", "555-8812", "greta.grant@", "12 Granted Lane"];
const FULL_PHONE = "(319) 555-8812";

const LOGINS = ["owner", "admin", "frontdesk", "michelle", "makenna", "regional", "coralville"] as const;
type Login = (typeof LOGINS)[number];
const people = {} as Record<Login, string>;
const ids = {} as { client: string; coralville: string; moline: string };
const as = (l: Login) => signInAs(people[l]);
const ctx = async () => (await (await import("@/server/auth/staff")).getStaffContext())!;
const policy = async () => (await import("@/server/client-privacy")).clientPolicy(await ctx());
const actions = () => import("@/app/admin/client-data/contact-access/actions");
const clientCsv = async () => get((await import("@/app/admin/customers/export/route")).GET as never, "/admin/customers/export");
const audits = (action: string) => m.db.db.select().from(m.schema.auditLog).where(eq(m.schema.auditLog.action, action));

async function give(kind: "full_contact" | "export", to: { staffId?: string; shopId?: string }, until: string | null = null) {
  const r = await (await actions()).giveContactGrantAction({ kind, staffId: to.staffId ?? null, shopId: to.shopId ?? null, until, note: "Reopening mailing" });
  if (!r.ok) throw new Error(r.error);
  return r.data.id;
}
async function revoke(id: string) {
  const r = await (await actions()).revokeContactGrantAction(id);
  expect(r).toMatchObject({ ok: true });
}

beforeAll(async () => {
  m = await loadModules();
  for (const l of LOGINS) people[l] = (await m.db.db.query.staff.findFirst({ where: eq(m.schema.staff.email, `${l}@rayz.test`) }))!.id;
  ids.coralville = (await m.db.db.query.shops.findFirst({ where: eq(m.schema.shops.slug, "coralville") }))!.id;
  ids.moline = (await m.db.db.query.shops.findFirst({ where: eq(m.schema.shops.slug, "moline") }))!.id;
  const [c] = await m.db.db
    .insert(m.schema.customers)
    .values({ firstName: P.first, lastName: P.last, phone: P.phone, email: P.email, address: P.address, homeShopId: ids.coralville, smsOptIn: true, emailOptIn: true })
    .returning();
  ids.client = c.id;
}, 180_000);

afterAll(async () => {
  await m?.db.closeDb();
});

describe("by default", () => {
  it("shop logins and staff see contact details masked and can't export", async () => {
    for (const who of ["coralville", "michelle", "frontdesk", "makenna", "regional"] as const) {
      await as(who);
      const p = await policy();
      for (const f of ["phone", "email", "address"] as const) expect(p.level(f), `${who} ${f}`).not.toBe("full");
      expect(found(String(p.show("phone", P.phone)), RAW), who).toEqual([]);
      expect((await clientCsv()).status, who).toBe(403);
    }
  });
});

describe("a grant to one person", () => {
  it("full contact details: they see them everywhere they work, still can't export, and it's logged", async () => {
    await as("owner");
    const id = await give("full_contact", { staffId: people.michelle });
    const [log] = await audits("client_contact.grant");
    expect(log).toMatchObject({ entityId: id, actorStaffId: people.owner, details: { person: "Michelle", what: expect.stringMatching(/in full/) } });

    await as("michelle");
    const p = await policy();
    for (const f of ["phone", "email", "address"] as const) expect(p.level(f), f).toBe("full");
    expect(p.show("phone", P.phone)).toBe(FULL_PHONE);
    const page = await open("/admin/customers/[id]", { id: ids.client });
    expect(page.kind).toBe("ok");
    expect(page.text).toContain(FULL_PHONE);
    expect(page.text).toContain(P.email);
    expect((await clientCsv()).status).toBe(403);

    // Others at the same shop are untouched.
    await as("frontdesk");
    expect((await policy()).level("phone")).not.toBe("full");

    await as("owner");
    await revoke(id);
    expect(await audits("client_contact.revoke")).toHaveLength(1);
    await as("michelle");
    expect((await policy()).level("phone")).not.toBe("full");
    expect(found(String((await policy()).show("phone", P.phone)), RAW)).toEqual([]);
  });

  it("exporting: the client list downloads with details as they see them, and every export is logged", async () => {
    await as("owner");
    const id = await give("export", { staffId: people.michelle });
    await as("michelle");
    const csv = await clientCsv();
    expect(csv.status, csv.text).toBe(200);
    expect(csv.text).toContain(P.last);
    expect(found(csv.text, RAW)).toEqual([]);
    const logged = await m.db.db.select().from(m.schema.clientAccessLog).where(eq(m.schema.clientAccessLog.staffId, people.michelle));
    expect(logged.filter((l) => l.kind === "export")).toHaveLength(1);
    expect((await audits("client.export")).filter((a) => a.actorStaffId === people.michelle)).toHaveLength(1);

    // With full contact details too, the export has them.
    await as("owner");
    const full = await give("full_contact", { staffId: people.michelle });
    await as("michelle");
    const both = await clientCsv();
    expect(both.text).toContain(P.email);

    await as("owner");
    await revoke(id);
    await revoke(full);
    await as("michelle");
    expect((await clientCsv()).status).toBe(403);
  });

  it("an end date in the past locks them out again", async () => {
    await m.db.db.insert(m.schema.clientContactGrants).values({ kind: "export", staffId: people.michelle, expiresAt: new Date(Date.now() - 60_000), grantedByLabel: "Brand Owner:Owner" });
    await as("michelle");
    expect((await clientCsv()).status).toBe(403);
  });

  it("the grant doesn't count as theirs to give on: overrides, roles and grants stay with the brand", async () => {
    await as("owner");
    const id = await give("export", { staffId: people.michelle });
    const { loadStaffAccess, accessState, grantor } = await import("@/server/auth/access");
    const a = (await loadStaffAccess(people.michelle))!;
    expect(a.permissions.has("clients.export")).toBe(true);
    expect(accessState(a).permissions.has("clients.export")).toBe(false);
    expect(grantor(a).permissions.has("clients.export")).toBe(false);
    await as("michelle");
    expect(await (await actions()).giveContactGrantAction({ kind: "export", staffId: people.frontdesk, shopId: null, until: null, note: null })).toMatchObject({ ok: false });
    await as("owner");
    await revoke(id);
  });
});

describe("a grant to a location", () => {
  it("covers everyone working there, including the shop login, and nobody elsewhere", async () => {
    await as("owner");
    const id = await give("export", { shopId: ids.coralville }, "2099-12-31");
    for (const who of ["coralville", "frontdesk", "michelle"] as const) {
      await as(who);
      const csv = await clientCsv();
      expect(csv.status, who).toBe(200);
      expect(found(csv.text, RAW), who).toEqual([]);
    }
    await as("regional");
    expect((await clientCsv()).status).toBe(403);
    await as("owner");
    const full = await give("full_contact", { shopId: ids.coralville });
    await as("coralville");
    expect((await policy()).show("phone", P.phone)).toBe(FULL_PHONE);
    expect((await clientCsv()).text).toContain(P.email);

    await as("owner");
    await revoke(id);
    await revoke(full);
    await as("coralville");
    expect((await clientCsv()).status).toBe(403);
    expect((await policy()).level("phone")).not.toBe("full");
  });
});

describe("who may give and revoke", () => {
  it("only brand-level people who manage client data, and only what they have", async () => {
    for (const who of ["michelle", "frontdesk", "coralville", "regional"] as const) {
      await as(who);
      expect(await (await actions()).giveContactGrantAction({ kind: "full_contact", staffId: people.makenna, shopId: null, until: null, note: null }), who).toMatchObject({ ok: false });
    }
    // Brand Admins see contact details in full but don't export unless the Brand Owner lets them.
    await as("admin");
    expect(await (await actions()).giveContactGrantAction({ kind: "export", staffId: people.makenna, shopId: null, until: null, note: null })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/can't export the client list yourself/),
    });
    const r = await (await actions()).giveContactGrantAction({ kind: "full_contact", staffId: people.makenna, shopId: null, until: null, note: null });
    expect(r).toMatchObject({ ok: true });
    expect(await (await actions()).giveContactGrantAction({ kind: "full_contact", staffId: people.makenna, shopId: null, until: null, note: null })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/already has that/),
    });
    expect(await (await actions()).giveContactGrantAction({ kind: "full_contact", staffId: people.makenna, shopId: null, until: "2020-01-01", note: null })).toMatchObject({ ok: false });
    await as("michelle");
    expect(await (await actions()).revokeContactGrantAction(r.ok ? r.data.id : "")).toMatchObject({ ok: false });
    await as("admin");
    expect(await (await actions()).revokeContactGrantAction(r.ok ? r.data.id : "")).toMatchObject({ ok: true });
    expect(await (await actions()).revokeContactGrantAction(r.ok ? r.data.id : "")).toMatchObject({ ok: false });
  });

  it("the brand sees every grant and export on the Contact access page; others can't open it", async () => {
    await as("owner");
    const page = await open("/admin/client-data/contact-access");
    expect(page.kind).toBe("ok");
    expect(page.text).toContain("Revoked");
    expect(page.text).toContain("Everyone at Coralville");
    expect(page.text).toContain("Michelle");
    expect(page.text).toMatch(/client list/);
    for (const who of ["michelle", "coralville"] as const) {
      await as(who);
      expect((await open("/admin/client-data/contact-access")).kind, who).toBe("denied");
    }
  });
});
