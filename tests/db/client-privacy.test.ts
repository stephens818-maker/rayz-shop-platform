/**
 * Client data protection. A client carries unique values in every protected field. The barber who
 * cuts her, the front desk, the shop manager and a brand-wide manager restricted by per-person rules open
 * every page that shows clients, call the search and import actions, download the exports and the
 * audit log, and none of them may receive a value their level hides or masks: not in the HTML, not
 * in props handed to the browser, not in action JSON, not in a CSV. Staff still find her by her full
 * number, call and text her through the shop line, and her reminders still go to her real number.
 * Reveals and exports are audited, and unusual lookups alert the brand admins and pause.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { brandAction } from "./brand";
import { fieldRule } from "./brand";
import { Mods, actor, loadModules } from "./setup";
import { found, get, open } from "./render";
import { signInAs } from "./session";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));

let m: Mods;
const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);
const and = (...a: Parameters<Mods["drizzle"]["and"]>) => m.drizzle.and(...a);

const P = {
  first: "Priya",
  last: "Secretfield",
  phone: "+13195559876",
  email: "priya.secret@example.test",
  oldAddress: "1 Old Road, Coralville, IA 52241",
  address: "4242 Hidden Lane, Coralville, IA 52241",
  birthday: "1987-11-23",
  notes: "SECRET-NOTE-9876",
  ratingNote: "SECRET-RATING-NOTE",
  instagram: "@priyasecret9876",
};
const PHONE = ["+13195559876", "3195559876", "5559876", "555-9876"];
const EMAIL = ["priya.secret@"];
const ADDRESS = ["4242 Hidden Lane", "1 Old Road"];
const BIRTHDAY = ["Nov 23", "1987-11-23"];
const INSTAGRAM = ["@priyasecret9876", "priyasecret"];

const shop: Record<string, string> = {};
const people: Record<string, string> = {};
const LOGINS = ["owner", "admin", "frontdesk", "michelle", "makenna", "regional", "kat"] as const;
type Login = (typeof LOGINS)[number];
const as = (l: Login, shopId?: string) => signInAs(people[l], shopId);
const ids = {} as { client: string; noSms: string; appt: string; openSale: string; sale: string; instagram: string };
let today: string;
let brandAdminRoleId: string;

/** What each restricted person must never receive about the client, with the rules set below. */
const NEVER: Record<"makenna" | "frontdesk" | "michelle" | "admin", string[]> = {
  makenna: [P.last, ...PHONE, ...EMAIL, ...ADDRESS, ...BIRTHDAY, ...INSTAGRAM, P.notes, P.ratingNote],
  frontdesk: [P.last, ...PHONE, ...EMAIL, ...ADDRESS, ...BIRTHDAY, ...INSTAGRAM, P.ratingNote],
  michelle: [P.last, ...PHONE, ...EMAIL, "4242 Hidden", "1 Old Road"],
  admin: [...PHONE, ...EMAIL, ...ADDRESS, ...BIRTHDAY, ...INSTAGRAM, P.notes, P.ratingNote],
};

const pageList = (): [string, Record<string, string>, Record<string, string>][] => [
  ["/admin", {}, {}],
  ["/admin/customers", {}, {}],
  ["/admin/customers", {}, { q: P.first }],
  ["/admin/customers", {}, { q: P.phone }],
  ["/admin/customers/[id]", { id: ids.client }, {}],
  ["/admin/customers/duplicates", {}, {}],
  ["/admin/calendar", {}, { date: today, shop: shop.coralville }],
  ["/admin/checkout/[saleId]", { saleId: ids.openSale }, {}],
  ["/admin/sales/[id]", { id: ids.sale }, {}],
  ["/admin/walk-ins", {}, {}],
  ["/admin/notifications", {}, {}],
  ["/admin/audit", {}, {}],
  ["/admin/audit", {}, { q: "Hidden Lane" }],
  ["/admin/reports/ratings", {}, { period: "all" }],
];

async function rule(field: string, level: "hidden" | "masked" | "full" | null, o: { roleKey?: string; staff?: Login; shopId?: string }) {
  const roleId = o.roleKey ? (await m.db.db.query.roles.findFirst({ where: eq(m.schema.roles.key, o.roleKey) }))!.id : null;
  return fieldRule({ field, level, roleId, staffId: o.staff ? people[o.staff] : null, shopId: o.shopId ?? null });
}

async function appointment(o: { staffId: string; customerId: string; at: Date; status: "completed" | "booked" }) {
  const [a] = await m.db.db
    .insert(m.schema.appointments)
    .values({
      code: `P${crypto.randomUUID().slice(0, 7).toUpperCase()}`,
      shopId: shop.coralville,
      staffId: o.staffId,
      customerId: o.customerId,
      startsAt: o.at,
      endsAt: new Date(o.at.getTime() + 30 * 60_000),
      status: o.status,
      source: "staff",
      estimateCents: 2300,
      completedAt: o.status === "completed" ? new Date(o.at.getTime() + 30 * 60_000) : null,
    })
    .returning();
  await m.db.db.insert(m.schema.appointmentItems).values({ appointmentId: a.id, kind: "service", name: "Ray'z Cut", priceCents: 2300, durationMin: 30 });
  return a.id;
}

const auditOf = async (action: string) => m.db.db.select().from(m.schema.auditLog).where(eq(m.schema.auditLog.action, action));
const accessOf = async (kind: string, staff: Login) =>
  m.db.db
    .select()
    .from(m.schema.clientAccessLog)
    .where(and(eq(m.schema.clientAccessLog.kind, kind as never), eq(m.schema.clientAccessLog.staffId, people[staff])));

beforeAll(async () => {
  m = await loadModules();
  today = m.time.todayLocal();
  for (const s of await m.db.db.select().from(m.schema.shops)) shop[s.slug] = s.id;
  for (const l of LOGINS) people[l] = (await m.db.db.query.staff.findFirst({ where: eq(m.schema.staff.email, `${l}@rayz.test`) }))!.id;
  // Brand Admins always see every client detail, so the restricted brand-wide person here is the
  // same login under a copy of the Brand Admin role that isn't the Brand Admin role: a brand-level
  // custom role, so only its per-person rules hold it back.
  const admin = (await m.db.db.query.roles.findFirst({ where: eq(m.schema.roles.key, "brand_admin") }))!;
  brandAdminRoleId = admin.id;
  const [copy] = await m.db.db
    .insert(m.schema.roles)
    .values({ key: "brand_auditor", name: "Brand auditor", permissions: admin.permissions, maxDiscountPct: admin.maxDiscountPct, defaultScope: "all", brandLevel: true })
    .returning();
  await m.db.db.update(m.schema.staff).set({ roleId: copy.id }).where(eq(m.schema.staff.id, people.admin));
  ids.instagram = (await m.db.db.query.clientFields.findFirst({ where: eq(m.schema.clientFields.label, "Instagram") }))!.id;
  const cv = shop.coralville;
  const at = (daysAgo: number, min: number) => m.time.zonedWallTime(m.time.addDays(today, -daysAgo), min).toJSDate();

  const [c] = await m.db.db
    .insert(m.schema.customers)
    .values({
      firstName: P.first,
      lastName: P.last,
      phone: P.phone,
      email: P.email,
      address: P.oldAddress,
      birthday: P.birthday,
      notes: P.notes,
      customFields: { [ids.instagram]: P.instagram },
      homeShopId: cv,
      smsOptIn: true,
      emailOptIn: true,
      preferredStaffId: people.makenna,
    })
    .returning();
  ids.client = c.id;
  const [n] = await m.db.db.insert(m.schema.customers).values({ firstName: "Omar", lastName: "Nosms", phone: "+13195558111", homeShopId: cv, smsOptIn: false }).returning();
  ids.noSms = n.id;

  const done = await appointment({ staffId: people.makenna, customerId: c.id, at: at(3, 10 * 60), status: "completed" });
  await appointment({ staffId: people.makenna, customerId: n.id, at: at(4, 10 * 60), status: "completed" });
  ids.appt = await appointment({ staffId: people.makenna, customerId: c.id, at: at(0, 20 * 60), status: "booked" });
  await m.db.db.insert(m.schema.clientRatings).values({ customerId: c.id, shopId: cv, appointmentId: done, staffId: people.makenna, stars: 2, note: P.ratingNote });

  const svc = (await m.catalog.shopCatalog(cv))[0].id;
  const s = await m.checkout.openBlankSale(cv, actor);
  await m.checkout.finalizeSale({ saleId: s.id, lines: [{ kind: "service", refId: svc, qty: 1 }], tipCents: 300, tender: { method: "cash", cashTenderedCents: null }, actor });
  await m.db.db.update(m.schema.sales).set({ customerId: c.id, staffId: people.makenna, appointmentId: done }).where(eq(m.schema.sales.id, s.id));
  ids.sale = s.id;
  ids.openSale = (await m.checkout.openBlankSale(cv, actor)).id;
  await m.db.db.update(m.schema.sales).set({ customerId: c.id, staffId: people.makenna }).where(eq(m.schema.sales.id, ids.openSale));

  await m.db.db.insert(m.schema.waitlistEntries).values({ shopId: cv, customerId: c.id, name: `${P.first} ${P.last}`, phone: P.phone });
  await m.queue.enqueueRaw({ kind: "confirmation", channel: "sms", to: P.phone, body: "Ray'z Coralville: see you soon", customerId: c.id, shopId: cv });
  await m.queue.enqueueRaw({ kind: "confirmation", channel: "email", to: P.email, subject: "See you soon", body: "See you soon", customerId: c.id, shopId: cv });

  // The owner edits the address, so the audit log holds the old and new one.
  await as("owner");
  const { updateCustomerAction } = await import("@/app/admin/customers/actions");
  const edit = await updateCustomerAction(c.id, {
    firstName: P.first,
    lastName: P.last,
    phone: P.phone,
    email: P.email,
    address: P.address,
    birthday: P.birthday,
    notes: P.notes,
    custom: { [ids.instagram]: P.instagram },
    smsOptIn: true,
    emailOptIn: true,
    homeShopId: cv,
    preferredStaffId: people.makenna,
  });
  expect(edit).toMatchObject({ ok: true });

  // Barbers at Coralville see notes masked and no ratings; the front desk sees ratings as averages;
  // one brand admin is restricted on nearly everything.
  for (const [field, level] of [
    ["notes", "masked"],
    ["ratings", "hidden"],
  ] as const)
    expect(await rule(field, level, { roleKey: "barber", shopId: cv })).toMatchObject({ ok: true });
  expect(await rule("ratings", "masked", { staff: "frontdesk" })).toMatchObject({ ok: true });
  for (const [field, level] of [
    ["phone", "masked"],
    ["email", "hidden"],
    ["address", "hidden"],
    ["birthday", "hidden"],
    ["notes", "masked"],
    ["ratings", "masked"],
    [`custom:${ids.instagram}`, "hidden"],
  ] as const)
    expect(await rule(field, level, { staff: "admin" })).toMatchObject({ ok: true });
}, 180_000);

afterAll(async () => {
  await m?.db.closeDb();
});

describe("the owner sees everything (so the absence below means something)", () => {
  it("every protected value shows up for the Brand Owner", async () => {
    await as("owner", shop.coralville);
    let all = "";
    for (const [route, params, sp] of pageList()) {
      const r = await open(route, params, sp);
      if (r.kind === "ok") all += r.text;
    }
    expect(["555-9876", P.email, P.address, "Nov 23, 1987", P.instagram, P.notes, P.ratingNote].filter((s) => !all.includes(s))).toEqual([]);
  }, 120_000);
});

describe("hidden and masked values never reach a restricted person's browser", () => {
  for (const who of ["makenna", "frontdesk", "michelle", "admin"] as const) {
    it(`${who}: no protected value on any page or in any prop, and the masked forms are there instead`, async () => {
      await as(who, who === "admin" ? undefined : shop.coralville);
      const leaks: string[] = [];
      let profile = "";
      let opened = 0;
      for (const [route, params, sp] of pageList()) {
        const r = await open(route, params, sp);
        if (r.kind !== "ok") continue;
        opened++;
        if (route === "/admin/customers/[id]") profile = r.text;
        // The client list's search box shows back the number the person typed, which they already know.
        const hits = found(route === "/admin/customers" && sp.q ? r.text.split(sp.q).join(" ") : r.text, NEVER[who]);
        if (hits.length) leaks.push(`${route}?${new URLSearchParams(sp)}: ${hits.join(", ")}`);
      }
      expect(leaks).toEqual([]);
      expect(opened).toBeGreaterThanOrEqual(who === "makenna" ? 5 : 9);
      // Below brand level a client's last name is an initial; a brand-level custom role sees it in full.
      expect(profile, "the profile opened").toContain(who === "admin" ? `${P.first} ${P.last}` : `${P.first} S.`);
      expect(profile).toContain("***-***-9876");
      if (who === "makenna") expect(profile).not.toContain("p***@");
      if (who === "frontdesk" || who === "michelle") expect(profile).toContain("p***@example.test");
      if (who === "michelle") expect(profile).toContain("***, Coralville, IA 52241");
      if (who === "makenna") expect(profile).toContain("On file");
    }, 120_000);
  }

  it("the audit log can't be searched for a detail the reader doesn't see", async () => {
    await as("admin");
    expect((await open("/admin/audit", {}, { q: "Hidden Lane" })).text).not.toContain("customer.update");
    await as("owner");
    expect((await open("/admin/audit", {}, { q: "Hidden Lane" })).text).toContain("customer.update");
  });

  it("a per-shop rule applies only at that shop", async () => {
    const { getStaffContext } = await import("@/server/auth/staff");
    const { clientPolicy } = await import("@/server/client-privacy");
    await as("makenna", shop.coralville);
    expect((await clientPolicy((await getStaffContext())!)).level("notes")).toBe("masked");
    await as("kat", shop.moline);
    expect((await clientPolicy((await getStaffContext())!)).level("notes")).toBe("full");
    expect((await clientPolicy((await getStaffContext())!)).level("ratings")).toBe("full");
  });
});

describe("staff still do their job", () => {
  it("search finds the client by her full number without revealing it; partial digits only for people who see numbers", async () => {
    const { searchCustomersAction } = await import("@/app/admin/calendar/actions");
    await as("frontdesk", shop.coralville);
    for (const term of [P.phone, "(319) 555-9876", "319-555-9876", P.email]) {
      const r = await searchCustomersAction(term);
      expect(r.ok && r.data.map((x) => x.id), term).toContain(ids.client);
      expect(found(JSON.stringify(r), NEVER.frontdesk), term).toEqual([]);
      expect(JSON.stringify(r)).toContain("***-***-9876");
    }
    for (const term of ["5559876", "555-98", "priya.secret@ex"]) {
      const r = await searchCustomersAction(term);
      expect(r.ok && r.data.map((x) => x.id), term).not.toContain(ids.client);
    }
    await as("owner", shop.coralville);
    const r = await searchCustomersAction("5559876");
    expect(r.ok && r.data.map((x) => x.id)).toContain(ids.client);
  });

  it("calls and texts go through the shop line: the number is used but never returned", async () => {
    const { contactClientAction } = await import("@/app/admin/customers/actions");
    await as("makenna", shop.coralville);
    const text = await contactClientAction(ids.client, { channel: "sms", message: "Running 10 minutes behind" });
    expect(text).toMatchObject({ ok: true, data: { to: "***-***-9876" } });
    expect(found(JSON.stringify(text), PHONE)).toEqual([]);
    const call = await contactClientAction(ids.client, { channel: "call" });
    expect(call).toMatchObject({ ok: true, data: { to: "***-***-9876" } });
    const jobs = await m.db.db.select().from(m.schema.notificationJobs).where(eq(m.schema.notificationJobs.customerId, ids.client));
    expect(jobs.find((j) => j.kind === "staff_text")).toMatchObject({ to: P.phone, channel: "sms", body: expect.stringContaining("Running 10 minutes behind") });
    expect(jobs.find((j) => j.kind === "staff_call")).toMatchObject({ to: P.phone, channel: "voice" });
    expect(jobs.filter((j) => j.kind.startsWith("staff_")).every((j) => j.status !== "pending")).toBe(true);
    expect((await auditOf("client.text")).some((a) => a.entityId === ids.client && a.actorStaffId === people.makenna)).toBe(true);
    expect((await auditOf("client.call")).some((a) => a.entityId === ids.client)).toBe(true);
    expect((await accessOf("contact", "makenna")).length).toBe(2);

    expect(await contactClientAction(ids.noSms, { channel: "sms", message: "Hi" })).toMatchObject({ ok: false, error: expect.stringMatching(/hasn't agreed to texts/) });
    expect(await contactClientAction(ids.noSms, { channel: "call" })).toMatchObject({ ok: true });
    await as("kat", shop.moline);
    expect(await contactClientAction(ids.client, { channel: "call" })).toMatchObject({ ok: false, error: expect.stringMatching(/not found/) });
  });

  it("reminders still go to the client's real number", async () => {
    const svc = (await m.public.publicServices("coralville")).services[0];
    let slot: string | undefined;
    for (let i = 3; i < 25 && !slot; i++)
      slot = (await m.booking.getAvailability({ shopRef: "coralville", date: m.time.addDays(today, i), serviceId: svc.id, barberRef: "any" })).slots.at(-1)?.startsAt;
    const appt = await m.booking.createAppointment({
      shopRef: "coralville",
      serviceId: svc.id,
      addonIds: [],
      barberRef: "any",
      startsAt: new Date(slot!),
      customerId: ids.client,
      source: "staff",
      actor,
    });
    const jobs = await m.db.db.select().from(m.schema.notificationJobs).where(eq(m.schema.notificationJobs.appointmentId, appt.id));
    expect(jobs.filter((j) => j.channel === "sms").map((j) => j.to)).toEqual(expect.arrayContaining([P.phone]));
    expect(jobs.some((j) => j.kind === "reminder_24h" && j.to === P.phone)).toBe(true);
    expect(jobs.some((j) => j.channel === "email" && j.to === P.email)).toBe(true);
    await m.queue.processDueJobs();
    const sent = await m.db.db
      .select()
      .from(m.schema.notificationJobs)
      .where(and(eq(m.schema.notificationJobs.appointmentId, appt.id), eq(m.schema.notificationJobs.kind, "confirmation")));
    expect(sent.every((j) => j.status === "sent" || j.status === "suppressed")).toBe(true);
  });

  it("saving the profile keeps the details the editor leaves alone", async () => {
    const { updateCustomerAction } = await import("@/app/admin/customers/actions");
    await as("frontdesk", shop.coralville);
    // The profile form sends only what's in an input: the details seen in full and anything typed in.
    const r = await updateCustomerAction(ids.client, {
      firstName: P.first,
      lastName: P.last,
      notes: P.notes,
      smsOptIn: true,
      emailOptIn: true,
      homeShopId: shop.coralville,
      preferredStaffId: people.makenna,
    });
    expect(r).toMatchObject({ ok: true });
    expect(found(JSON.stringify(r), NEVER.frontdesk)).toEqual([]);
    const c = (await m.db.db.query.customers.findFirst({ where: eq(m.schema.customers.id, ids.client) }))!;
    expect(c).toMatchObject({ phone: P.phone, email: P.email, address: P.address, birthday: P.birthday, notes: P.notes, customFields: { [ids.instagram]: P.instagram } });
  });
});

describe("reveal with a reason", () => {
  it("shows one masked detail to a manager, logged with who, when, which client, which field and why", async () => {
    const { revealClientFieldAction } = await import("@/app/admin/customers/actions");
    await as("owner");
    expect(await rule("birthday", "masked", { staff: "michelle" })).toMatchObject({ ok: true });
    await as("michelle", shop.coralville);
    expect(await revealClientFieldAction({ customerId: ids.client, field: "birthday", reason: "no" })).toMatchObject({ ok: false });
    expect(await revealClientFieldAction({ customerId: ids.client, field: "ratings", reason: "Need the detail" })).toMatchObject({ ok: false });
    const r = await revealClientFieldAction({ customerId: ids.client, field: "birthday", reason: "Client asked us to confirm her birthday" });
    expect(r).toEqual({ ok: true, data: { value: "Nov 23, 1987" } });
    const [log] = await accessOf("reveal", "michelle");
    expect(log).toMatchObject({ customerId: ids.client, field: "birthday", reason: "Client asked us to confirm her birthday", shopId: shop.coralville });
    expect(log.at.getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect((await auditOf("client.reveal")).find((a) => a.entityId === ids.client)).toMatchObject({
      actorStaffId: people.michelle,
      details: { field: "birthday", reason: "Client asked us to confirm her birthday" },
    });
    await as("owner");
    expect(await rule("birthday", null, { staff: "michelle" })).toMatchObject({ ok: true });
  });

  it("never reveals phone, email or address at shop level, however good the reason", async () => {
    const { revealClientFieldAction } = await import("@/app/admin/customers/actions");
    await as("michelle", shop.coralville);
    for (const field of ["phone", "email", "address"]) {
      const r = await revealClientFieldAction({ customerId: ids.client, field, reason: "Client asked us to confirm it" });
      expect(r, field).toMatchObject({ ok: false, error: expect.stringMatching(/only with contact access from the brand/) });
      expect(found(JSON.stringify(r), [...PHONE, ...EMAIL, ...ADDRESS]), field).toEqual([]);
    }
    expect((await accessOf("reveal", "michelle")).filter((l) => l.field !== "birthday")).toEqual([]);
  });

  it("is refused without the permission, and for a hidden detail", async () => {
    const { revealClientFieldAction } = await import("@/app/admin/customers/actions");
    await as("makenna", shop.coralville);
    expect(await revealClientFieldAction({ customerId: ids.client, field: "phone", reason: "Want to call her" })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/can't reveal/),
    });
    await as("admin");
    expect(await revealClientFieldAction({ customerId: ids.client, field: "address", reason: "Mailing a gift card" })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/hidden/),
    });
    expect((await accessOf("reveal", "makenna")).length + (await accessOf("reveal", "admin")).length).toBe(0);
  });
});

describe("exports", () => {
  it("the client list export is the Brand Owner's alone by default, and is audited with the clients and fields", async () => {
    const route = await import("@/app/admin/customers/export/route");
    for (const who of ["admin", "michelle", "frontdesk", "makenna"] as const) {
      await as(who);
      expect((await get(route.GET as never, "/admin/customers/export")).status, who).toBe(403);
    }
    await as("owner");
    const full = await get(route.GET as never, "/admin/customers/export");
    expect(full.status).toBe(200);
    expect(full.text).toContain(P.address);
    expect(full.text).toContain(P.instagram);
    const audited = (await auditOf("client.export")).find((a) => (a.details as { export?: string }).export === "client_list" && a.actorStaffId === people.owner)!;
    expect((audited.details as { customerIds: string[] }).customerIds).toContain(ids.client);
    expect((audited.details as { fields: string[] }).fields).toEqual(expect.arrayContaining(["phone:full", "address:full"]));
    expect((await accessOf("export", "owner")).length).toBeGreaterThan(0);
  });

  it("someone given the export gets each detail only as they see it", async () => {
    const route = await import("@/app/admin/customers/export/route");
    await m.db.db
      .update(m.schema.staff)
      .set({ permissionOverrides: { "clients.export": true } })
      .where(eq(m.schema.staff.id, people.admin));
    await as("admin");
    const r = await get(route.GET as never, "/admin/customers/export");
    await m.db.db.update(m.schema.staff).set({ permissionOverrides: {} }).where(eq(m.schema.staff.id, people.admin));
    expect(r.status).toBe(200);
    expect(found(r.text, NEVER.admin)).toEqual([]);
    expect(r.text).toContain("***-***-9876");
    const header = r.text.split("\n")[0];
    expect(header).toContain("Phone");
    for (const col of ["Email", "Address", "Birthday", "Instagram"]) expect(header.split(","), col).not.toContain(col);
    const audited = (await auditOf("client.export")).filter((a) => a.actorStaffId === people.admin);
    expect(audited.at(-1)!.details).toMatchObject({ export: "client_list", fields: expect.arrayContaining(["phone:masked", "notes:masked"]) });
  });

  it("the ratings export leaves out notes when ratings are masked, and is audited", async () => {
    const route = await import("@/app/admin/reports/ratings/export/route");
    await as("admin");
    const r = await get(route.GET as never, `/admin/reports/ratings/export?shop=${shop.coralville}&period=all`);
    expect(r.status).toBe(200);
    expect(r.text).toContain(P.last);
    expect(r.text).not.toContain("Latest note");
    expect(found(r.text, NEVER.admin)).toEqual([]);
    expect((await auditOf("client.export")).some((a) => a.actorStaffId === people.admin && (a.details as { export?: string }).export === "client_ratings")).toBe(true);
    await as("owner");
    expect((await get(route.GET as never, `/admin/reports/ratings/export?shop=${shop.coralville}&period=all`)).text).toContain(P.ratingNote);
  });

  it("the audit log CSV shows client changes as the reader may see them", async () => {
    const route = await import("@/app/admin/reports/export/route");
    await as("admin");
    const r = await get(route.GET as never, `/admin/reports/export?type=audit_log&shop=all&preset=30d`);
    expect(r.status).toBe(200);
    expect(r.text).toContain("customer.update");
    expect(found(r.text, NEVER.admin)).toEqual([]);
    expect(r.text).toContain("(hidden)");
    await as("owner");
    expect((await get(route.GET as never, `/admin/reports/export?type=audit_log&shop=all&preset=30d`)).text).toContain(P.address);
  });

  it("the import preview and the skipped-rows file mask client columns, and the file is audited", async () => {
    const { importAction } = await import("@/app/admin/import/actions");
    const errors = await import("@/app/admin/import/[runId]/errors/route");
    const csv = `First Name,Last Name,Phone,Email,Notes\n,,${P.phone},${P.email},${P.notes}\n`;
    await as("admin");
    const preview = await importAction({ kind: "clients", csv, dryRun: true });
    expect(preview.ok).toBe(true);
    expect(found(JSON.stringify(preview), NEVER.admin)).toEqual([]);
    expect(preview.ok && preview.data.errors[0].data).toMatchObject({ Phone: "***-***-9876", Email: "", Notes: "On file" });
    const run = await importAction({ kind: "clients", csv, dryRun: false });
    const runId = run.ok ? run.data.runId! : "";
    const file = await get(errors.GET as never, `/admin/import/${runId}/errors`, { runId });
    expect(file.status).toBe(200);
    expect(file.text).toContain("***-***-9876");
    expect(found(file.text, NEVER.admin)).toEqual([]);
    expect((await auditOf("client.export")).some((a) => a.entityId === runId && a.actorStaffId === people.admin)).toBe(true);
    await as("owner");
    expect((await get(errors.GET as never, `/admin/import/${runId}/errors`, { runId })).text).toContain(P.phone);
  });

  it("the customer's own API never carries staff-only details", async () => {
    const token = (await m.auth.issueTokens(ids.client, null)).accessToken;
    const headers = { authorization: `Bearer ${token}` };
    const me = await import("@/app/api/v1/me/route");
    const mine = await import("@/app/api/v1/me/appointments/route");
    const loyalty = await import("@/app/api/v1/me/loyalty/route");
    const staffOnly = [P.notes, P.ratingNote, ...INSTAGRAM, ...ADDRESS, ...BIRTHDAY, "ratings", "stars", "customFields"];
    // The client's own birthday is on /me (C16: they set it there); it's still nowhere else.
    const ownBirthday = new Set<string>(BIRTHDAY);
    for (const [h, url] of [
      [me.GET, "/api/v1/me"],
      [mine.GET, "/api/v1/me/appointments"],
      [loyalty.GET, "/api/v1/me/loyalty"],
    ] as const) {
      const r = await get(h as never, url, undefined, { headers });
      expect(r.status, url).toBe(200);
      expect(found(r.text, url === "/api/v1/me" ? staffOnly.filter((x) => !ownBirthday.has(x)) : staffOnly), url).toEqual([]);
    }
  });
});

describe("the brand portal", () => {
  it("rules are audited, nobody changes what they see themselves, and nobody gives more than they see", async () => {
    await as("admin");
    expect(await rule("phone", "full", { staff: "admin" })).toMatchObject({ ok: false, error: expect.stringMatching(/what you see yourself/) });
    expect(await rule("phone", "full", { roleKey: "brand_admin" })).toMatchObject({ ok: false });
    expect(await rule("phone", "full", { roleKey: "front_desk" })).toMatchObject({ ok: false, error: expect.stringMatching(/Give a person or a location contact access/) });
    expect(await rule("birthday", "full", { roleKey: "front_desk" })).toMatchObject({ ok: false, error: expect.stringMatching(/more than you see/) });
    expect(await rule("phone", "hidden", { roleKey: "front_desk", shopId: shop.moline })).toMatchObject({ ok: true });
    expect(await rule("phone", null, { roleKey: "front_desk", shopId: shop.moline })).toMatchObject({ ok: true });
    const logged = (await auditOf("client_data.rule")).filter((a) => a.actorStaffId === people.admin);
    expect(logged).toHaveLength(2);
    expect(logged.map((a) => a.details)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "Phone", for: { role: "Front Desk" }, where: "Moline", from: "inherit", to: "hidden" }),
        expect.objectContaining({ field: "Phone", for: { role: "Front Desk" }, where: "Moline", from: "hidden", to: "inherit" }),
      ]),
    );
    await as("makenna", shop.coralville);
    expect(await rule("phone", "full", { staff: "makenna" })).toMatchObject({ ok: false });
    expect((await open("/admin/client-data")).kind).toBe("denied");
    expect((await open("/admin/client-data/access")).kind).toBe("denied");
  });

  it("the data-access report shows who viewed and revealed what, and exports as CSV", async () => {
    await as("owner");
    const page = await open("/admin/client-data/access", {}, { days: "1" });
    expect(page.kind).toBe("ok");
    expect(page.text).toContain("Revealed birthday");
    expect(page.text).toContain("Client asked us to confirm her birthday");
    expect(page.text).toContain("Michelle");
    const byClient = await open("/admin/client-data/access", {}, { days: "1", client: ids.client });
    expect(byClient.text).toContain(`${P.first} ${P.last}`);
    expect(byClient.text).toContain("Opened profile");
    const route = await import("@/app/admin/client-data/access/export/route");
    const csv = await get(route.GET as never, `/admin/client-data/access/export?days=1&kind=reveal`);
    expect(csv.text.split("\n")[0]).toBe("When,Who,What,Field,Client,Client ID,Reason,Shop");
    expect(csv.text).toContain("Client asked us to confirm her birthday");
    expect((await auditOf("client_data.access_export")).length).toBe(1);
    const settings = await open("/admin/client-data", {}, { shop: shop.coralville, who: people.makenna });
    expect(settings.kind).toBe("ok");
    expect(settings.text).toContain("Instagram");
  });
});

describe("Brand Admins always see everything", () => {
  it("rules can't restrict a Brand Admin, and a Brand Admin's earlier per-person rules no longer apply", async () => {
    await m.db.db.update(m.schema.staff).set({ roleId: brandAdminRoleId }).where(eq(m.schema.staff.id, people.admin));
    await as("owner");
    expect(await rule("phone", "hidden", { roleKey: "brand_admin" })).toMatchObject({ ok: false, error: expect.stringMatching(/Brand Admins always/) });
    expect(await rule("phone", "hidden", { staff: "admin" })).toMatchObject({ ok: false, error: expect.stringMatching(/Brand Admins always/) });
    const { getStaffContext } = await import("@/server/auth/staff");
    const { clientPolicy } = await import("@/server/client-privacy");
    await as("admin");
    const policy = await clientPolicy((await getStaffContext())!);
    for (const f of ["phone", "email", "address", "birthday", "notes", "ratings", "photo", `custom:${ids.instagram}`] as const) expect(policy.level(f as never), f).toBe("full");
    const profile = await open("/admin/customers/[id]", { id: ids.client });
    for (const v of [P.email, P.address, P.notes, P.instagram]) expect(profile.text).toContain(v);
  });
});

describe("unusual lookups", () => {
  it("alert the brand admins past the alert level, then pause lookups; the owner is never paused", async () => {
    const { acknowledgeAlertAction } = await import("@/app/admin/client-data/actions");
    await as("owner");
    expect(await brandAction("setting", "lookup_limits", { windowMinutes: 10, alertProfiles: 3, blockProfiles: 5, alertSearches: 150, blockSearches: 300 })).toMatchObject({ ok: true });
    const molineClients = await m.db.db.select({ id: m.schema.customers.id }).from(m.schema.customers).where(eq(m.schema.customers.homeShopId, shop.moline)).limit(8);
    await as("regional");
    const outcomes: string[] = [];
    for (const c of molineClients.slice(0, 7)) {
      const r = await open("/admin/customers/[id]", { id: c.id });
      outcomes.push(r.kind === "ok" && r.text.includes("lookups paused") ? "paused" : r.kind);
    }
    expect(outcomes).toEqual(["ok", "ok", "ok", "ok", "ok", "paused", "paused"]);
    const alerts = await m.db.db.select().from(m.schema.clientAccessAlerts).where(eq(m.schema.clientAccessAlerts.staffId, people.regional));
    expect(alerts.map((a) => a.kind).sort()).toEqual(["paused", "unusual"]);
    const mail = await m.db.db.select().from(m.schema.notificationJobs).where(eq(m.schema.notificationJobs.kind, "privacy_alert"));
    expect(mail.map((j) => j.to).sort()).toEqual(expect.arrayContaining(["admin@rayz.test", "owner@rayz.test"]));
    expect(mail.every((j) => j.body.includes("/admin/client-data/access"))).toBe(true);
    expect((await accessOf("blocked", "regional")).length).toBe(2);

    await as("owner");
    for (const c of molineClients) expect((await open("/admin/customers/[id]", { id: c.id })).text).not.toContain("lookups paused");
    const page = await open("/admin/client-data/access", {}, { days: "1" });
    expect(page.text).toContain("Unusual lookups");
    expect(await acknowledgeAlertAction(alerts[0].id)).toMatchObject({ ok: true });
    expect((await m.db.db.query.clientAccessAlerts.findFirst({ where: eq(m.schema.clientAccessAlerts.id, alerts[0].id) }))!.acknowledgedBy).toBe(people.owner);
    expect(await brandAction("setting", "lookup_limits", { windowMinutes: 10, alertProfiles: 25, blockProfiles: 50, alertSearches: 150, blockSearches: 300 })).toMatchObject({ ok: true });
    expect((await auditOf("client_data.limits")).length).toBe(2);
  });
});
