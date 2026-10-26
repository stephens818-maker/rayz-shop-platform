/**
 * Entering client details is set apart from seeing them. Restricted staff type a phone number (and
 * an address, and notes) into a new client, a profile, a booking, a walk-in and checkout: it's
 * stored in full, and both the action's answer and the page they reload show it only masked or as
 * "Saved, hidden by policy". Replacing a detail never shows the old one. Add and edit are their own
 * rules in the brand portal; a refused edit is refused whatever the value, so it can't confirm a guess.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Mods, actor, loadModules } from "./setup";
import { found, open, propsOf } from "./render";
import { signInAs } from "./session";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));
vi.mock("next/navigation", async (orig) => ({ ...(await orig<typeof import("next/navigation")>()), useRouter: () => ({ refresh() {}, push() {} }) }));

let m: Mods;
const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);

const LOGINS = ["owner", "admin", "frontdesk", "michelle", "makenna"] as const;
type Login = (typeof LOGINS)[number];
const people = {} as Record<Login, string>;
const roleIds: Record<string, string> = {};
let cv: string;
let serviceId: string;
const as = (l: Login) => signInAs(people[l], cv);

/** Every way a number could show up in full. */
const full = (digits: string) => [`+1${digits}`, digits, `${digits.slice(3, 6)}-${digits.slice(6)}`, `${digits.slice(3, 6)}${digits.slice(6)}`];
const masked = (digits: string) => `***-***-${digits.slice(6)}`;

const NEW = { phone: "3195557171", address: "77 Quiet Street, Iowa City, IA 52240" };
const REPLACED = "3195557272";
const CHECKOUT = "3195557373";
const WALKIN = "3195557474";
const BOOKED = "3195557575";
const NOTE = "Skin fade, #1 guard, NOTE-7575";
let booked: string;

type Shown = { key: string; level: string; value: string | null; saved: boolean; canAdd: boolean; canEdit: boolean };
const client = async (id: string) => (await m.db.db.query.customers.findFirst({ where: eq(m.schema.customers.id, id) }))!;
const byPhone = async (digits: string) => m.db.db.query.customers.findFirst({ where: eq(m.schema.customers.phone, `+1${digits}`) });
const json = (v: unknown) => JSON.stringify(v);

async function rule(field: string, setting: "view" | "add" | "edit", level: string | null, o: { roleKey?: string; staff?: Login; shopId?: string | null }) {
  const { setFieldRuleAction } = await import("@/app/admin/client-data/actions");
  return setFieldRuleAction({ field, setting, level, roleId: o.roleKey ? roleIds[o.roleKey] : null, staffId: o.staff ? people[o.staff] : null, shopId: o.shopId ?? null });
}

/** The profile as the signed-in person reloads it: the page's text and props, and the editor's HTML. */
async function profile(id: string) {
  const { CustomerEditor, NotesEditor } = await import("@/app/admin/customers/[id]/editor");
  const page = await open("/admin/customers/[id]", { id });
  if (page.kind !== "ok") throw new Error(`profile didn't open: ${page.kind}`);
  const [editor] = await propsOf<Parameters<typeof CustomerEditor>[0]>(CustomerEditor, "/admin/customers/[id]", { id });
  const [notes] = editor ? [] : await propsOf<Parameters<typeof NotesEditor>[0]>(NotesEditor, "/admin/customers/[id]", { id });
  const html = editor ? renderToStaticMarkup(createElement(CustomerEditor, editor)) : renderToStaticMarkup(createElement(NotesEditor, notes));
  const fields = (editor?.fields ?? [notes.notes, ...notes.fields]) as Shown[];
  return { text: page.text, html, fields, field: (k: string) => fields.find((f) => f.key === k)! };
}

beforeAll(async () => {
  m = await loadModules();
  for (const s of await m.db.db.select().from(m.schema.shops)) if (s.slug === "coralville") cv = s.id;
  for (const l of LOGINS) people[l] = (await m.db.db.query.staff.findFirst({ where: eq(m.schema.staff.email, `${l}@rayz.test`) }))!.id;
  for (const r of await m.db.db.select().from(m.schema.roles)) if (r.key) roleIds[r.key] = r.id;
  serviceId = (await m.catalog.shopCatalog(cv)).find((s) => s.kind === "service")!.id;
  await as("owner");
  // The shop manager doesn't see phone numbers at all.
  expect(await rule("phone", "view", "hidden", { staff: "michelle" })).toMatchObject({ ok: true });
}, 180_000);

afterAll(async () => {
  await m?.db.closeDb();
});

describe("a restricted person enters a phone number", () => {
  let id: string;

  it("on a new client: stored in full; the answer and the reloaded profile show it masked, and the address as saved but hidden", async () => {
    const { createCustomerAction } = await import("@/app/admin/customers/actions");
    await as("frontdesk");
    const r = await createCustomerAction({
      firstName: "Nadia",
      lastName: "Entrytest",
      phone: "(319) 555-7171",
      address: NEW.address,
      smsOptIn: true,
      emailOptIn: false,
      homeShopId: cv,
    });
    expect(r).toMatchObject({ ok: true, data: { existed: false } });
    expect(found(json(r), [...full(NEW.phone), NEW.address])).toEqual([]);
    id = r.ok ? r.data.id : "";
    expect(await client(id)).toMatchObject({ phone: `+1${NEW.phone}`, address: NEW.address });

    const p = await profile(id);
    expect(found(p.text + p.html, [...full(NEW.phone), "77 Quiet Street"])).toEqual([]);
    expect(p.field("phone")).toMatchObject({ level: "masked", value: masked(NEW.phone), saved: true, canEdit: true });
    expect(p.field("address")).toMatchObject({ level: "hidden", value: null, saved: true });
    expect(p.html).toContain(masked(NEW.phone));
    expect(p.html).toContain("Saved, hidden by policy");
    expect(p.html).toContain("Replace");
  });

  it("replacing it: the old number is never shown, the new one is stored, and the answer is masked", async () => {
    const { updateCustomerAction } = await import("@/app/admin/customers/actions");
    await as("frontdesk");
    const r = await updateCustomerAction(id, { firstName: "Nadia", lastName: "Entrytest", phone: "319-555-7272", smsOptIn: true, emailOptIn: false, homeShopId: cv });
    expect(r).toMatchObject({ ok: true });
    expect(found(json(r), [...full(REPLACED), ...full(NEW.phone), NEW.address])).toEqual([]);
    expect(r.ok && r.data.fields.find((f) => f.key === "phone")).toMatchObject({ level: "masked", value: masked(REPLACED), saved: true });
    expect(r.ok && r.data.fields.find((f) => f.key === "address")).toMatchObject({ level: "hidden", value: null, saved: true });
    expect(await client(id)).toMatchObject({ phone: `+1${REPLACED}`, address: NEW.address });

    const p = await profile(id);
    expect(found(p.text + p.html, [...full(REPLACED), ...full(NEW.phone)])).toEqual([]);
    expect(p.html).toContain(masked(REPLACED));
  });

  it("someone who doesn't see phone numbers at all replaces one: stored, and shown back only as saved but hidden", async () => {
    const { updateCustomerAction } = await import("@/app/admin/customers/actions");
    await as("michelle");
    const r = await updateCustomerAction(id, { firstName: "Nadia", lastName: "Entrytest", phone: "(319) 555-7171", smsOptIn: true, emailOptIn: false, homeShopId: cv });
    expect(r).toMatchObject({ ok: true });
    expect(found(json(r), [...full(NEW.phone), ...full(REPLACED), masked(NEW.phone)])).toEqual([]);
    expect(r.ok && r.data.fields.find((f) => f.key === "phone")).toMatchObject({ level: "hidden", value: null, saved: true });
    expect((await client(id)).phone).toBe(`+1${NEW.phone}`);
    const p = await profile(id);
    expect(found(p.text + p.html, [...full(NEW.phone), masked(NEW.phone)])).toEqual([]);
    expect(p.field("phone")).toMatchObject({ level: "hidden", value: null, saved: true, canEdit: true });
    expect(p.html).toContain("Saved, hidden by policy");
  });

  it("at checkout: the new client goes on the ticket with the number stored, and checkout shows it masked", async () => {
    const { newClientAtCheckoutAction } = await import("@/app/admin/checkout/actions");
    const sale = await m.checkout.openBlankSale(cv, actor);
    await as("frontdesk");
    const r = await newClientAtCheckoutAction(sale.id, { firstName: "Theo", lastName: "Checkout", phone: "(319) 555-7373" });
    expect(r).toMatchObject({ ok: true });
    expect(found(json(r), full(CHECKOUT))).toEqual([]);
    const c = (await byPhone(CHECKOUT))!;
    expect(c).toMatchObject({ firstName: "Theo" });
    expect((await m.db.db.query.sales.findFirst({ where: eq(m.schema.sales.id, sale.id) }))!.customerId).toBe(c.id);
    const page = await open("/admin/checkout/[saleId]", { saleId: sale.id });
    expect(page.kind).toBe("ok");
    expect(found(page.text!, full(CHECKOUT))).toEqual([]);
    expect(page.text).toContain(masked(CHECKOUT));
    const p = await profile(c.id);
    expect(found(p.text + p.html, full(CHECKOUT))).toEqual([]);
    expect(p.html).toContain(masked(CHECKOUT));
  });

  it("at a walk-in, by someone who doesn't see numbers: stored, and nowhere on the walk-in board or the profile", async () => {
    const { walkInAction } = await import("@/app/admin/walk-ins/actions");
    await as("michelle");
    const r = await walkInAction({ shopId: cv, serviceId, name: "Wren Walkin", phone: "(319) 555-7474", preferredStaffId: null });
    expect(r).toMatchObject({ ok: true });
    expect(found(json(r), [...full(WALKIN), masked(WALKIN)])).toEqual([]);
    const c = (await byPhone(WALKIN))!;
    expect(c).toMatchObject({ firstName: "Wren" });
    const board = await open("/admin/walk-ins");
    expect(found(board.text ?? "", [...full(WALKIN), masked(WALKIN)])).toEqual([]);
    const p = await profile(c.id);
    expect(found(p.text + p.html, [...full(WALKIN), masked(WALKIN)])).toEqual([]);
    expect(p.html).toContain("Saved, hidden by policy");
  });

  it("booking a new client into a barber's own column: stored, and the barber sees it masked", async () => {
    const { createStaffAppointmentAction } = await import("@/app/admin/calendar/actions");
    const today = m.time.todayLocal();
    let slot: string | undefined;
    for (let i = 2; i < 30 && !slot; i++)
      slot = (await m.booking.getAvailability({ shopRef: "coralville", date: m.time.addDays(today, i), serviceId, barberRef: people.makenna })).slots.at(-1)?.startsAt;
    expect(slot, "makenna has an open slot").toBeTruthy();
    await as("makenna");
    const r = await createStaffAppointmentAction({
      shopId: cv,
      staffId: people.makenna,
      date: m.time.localDateOf(slot!),
      startMin: m.time.localMinutesOf(slot!),
      serviceId,
      addonIds: [],
      customer: { firstName: "Bo", lastName: "Booked", phone: "(319) 555-7575" },
    });
    expect(r).toMatchObject({ ok: true });
    expect(found(json(r), full(BOOKED))).toEqual([]);
    const c = (await byPhone(BOOKED))!;
    expect(c).toMatchObject({ firstName: "Bo" });
    booked = c.id;
    const p = await profile(c.id);
    expect(found(p.text + p.html, full(BOOKED))).toEqual([]);
    expect(p.text).toContain(masked(BOOKED));
  });

  it("notes a barber can't see: written over without the old ones shown, and shown back as saved but hidden", async () => {
    const { updateNotesAction } = await import("@/app/admin/customers/actions");
    await as("owner");
    expect(await rule("notes", "view", "hidden", { roleKey: "barber" })).toMatchObject({ ok: true });
    await m.db.db.update(m.schema.customers).set({ notes: "OLD-NOTE-1234" }).where(eq(m.schema.customers.id, booked));
    await as("makenna");
    const r = await updateNotesAction(booked, NOTE);
    expect(r).toMatchObject({ ok: true, data: { notes: { level: "hidden", value: null, saved: true } } });
    expect(found(json(r), [NOTE, "NOTE-7575", "OLD-NOTE-1234"])).toEqual([]);
    expect((await client(booked)).notes).toBe(NOTE);
    const p = await profile(booked);
    expect(found(p.text + p.html, ["NOTE-7575", "OLD-NOTE"])).toEqual([]);
    expect(p.field("notes")).toMatchObject({ level: "hidden", saved: true, canEdit: true });
    expect(p.html).toContain("Saved, hidden by policy");
    expect(p.html).toContain("Replace");
  });
});

describe("the other details at the desk", () => {
  const ADDRESS = "12 Desk Lane, Coralville, IA 52241";
  let instagram: string;
  const audits = async (id: string) =>
    m.db.db.select().from(m.schema.auditLog).where(m.drizzle.and(eq(m.schema.auditLog.entityId, id), eq(m.schema.auditLog.action, "customer.details_added")));

  beforeAll(async () => {
    instagram = (await m.db.db.query.clientFields.findFirst({ where: eq(m.schema.clientFields.label, "Instagram") }))!.id;
  });

  it("checkout takes email, address, birthday, notes and custom fields for a new client, and audits which were added", async () => {
    const { newClientAtCheckoutAction } = await import("@/app/admin/checkout/actions");
    const sale = await m.checkout.openBlankSale(cv, actor);
    await as("frontdesk");
    const r = await newClientAtCheckoutAction(sale.id, {
      firstName: "Dana",
      lastName: "Details",
      phone: "(319) 555-7801",
      email: "Dana.Details@Example.test",
      address: ADDRESS,
      birthday: "1990-04-12",
      notes: "Low taper",
      custom: { [instagram]: "@dana.cuts" },
    });
    expect(r).toMatchObject({ ok: true });
    const c = (await byPhone("3195557801"))!;
    expect(c).toMatchObject({ email: "dana.details@example.test", address: ADDRESS, birthday: "1990-04-12", notes: "Low taper", customFields: { [instagram]: "@dana.cuts" } });
    const [a] = await audits(c.id);
    expect((a.details as { fields: string[] }).fields.sort()).toEqual(["address", "birthday", "customFields", "notes"]);
  });

  it("a walk-in takes them too, and a bad birthday is refused before anyone is added", async () => {
    const { walkInAction } = await import("@/app/admin/walk-ins/actions");
    await as("michelle");
    const bad = await walkInAction({ shopId: cv, serviceId, name: "Wes Walk", phone: "(319) 555-7802", preferredStaffId: null, details: { birthday: "2999-01-01" } });
    expect(bad).toEqual({ ok: false, error: expect.stringContaining("Birthday") });
    expect(await byPhone("3195557802")).toBeUndefined();
    const r = await walkInAction({ shopId: cv, serviceId, name: "Wes Walk", phone: "(319) 555-7802", preferredStaffId: null, details: { address: ADDRESS, email: "wes@walk.test" } });
    expect(r).toMatchObject({ ok: true });
    expect(await byPhone("3195557802")).toMatchObject({ address: ADDRESS, email: "wes@walk.test" });
  });

  it("booking on the calendar fills what's empty on a returning client and keeps what's on file", async () => {
    const { createStaffAppointmentAction } = await import("@/app/admin/calendar/actions");
    const c = (await byPhone("3195557801"))!;
    const today = m.time.todayLocal();
    let slot: string | undefined;
    for (let i = 3; i < 30 && !slot; i++)
      slot = (await m.booking.getAvailability({ shopRef: "coralville", date: m.time.addDays(today, i), serviceId, barberRef: people.makenna })).slots.at(-1)?.startsAt;
    await as("frontdesk");
    await m.db.db.update(m.schema.customers).set({ birthday: null }).where(eq(m.schema.customers.id, c.id));
    const r = await createStaffAppointmentAction({
      shopId: cv,
      staffId: people.makenna,
      date: m.time.localDateOf(slot!),
      startMin: m.time.localMinutesOf(slot!),
      serviceId,
      addonIds: [],
      customer: { firstName: "Dana", lastName: "Details", phone: "(319) 555-7801" },
      details: { address: "1 Other Road, Iowa City, IA", birthday: "1990-04-13" },
    });
    expect(r).toMatchObject({ ok: true });
    expect(await client(c.id)).toMatchObject({ address: ADDRESS, birthday: "1990-04-13" });
  });

  it("a detail someone can't add isn't offered on the calendar, walk-ins or checkout, and is refused if sent", async () => {
    const { createStaffAppointmentAction } = await import("@/app/admin/calendar/actions");
    const { DayCalendar } = await import("@/app/admin/calendar/day-calendar");
    const { WalkIns } = await import("@/app/admin/walk-ins/walk-ins");
    const { Pos } = await import("@/app/admin/checkout/[saleId]/pos");
    await as("owner");
    expect(await rule("address", "add", "deny", { roleKey: "front_desk", shopId: cv })).toMatchObject({ ok: true });
    await as("frontdesk");
    const keys = (fs: { key: string }[]) => fs.map((f) => f.key);
    const [cal] = await propsOf<{ canManage: { entry: { key: string }[] } }>(DayCalendar, "/admin/calendar", {}, { shop: cv });
    expect(keys(cal.canManage.entry)).toEqual(expect.arrayContaining(["phone", "email", "birthday", "notes", `custom:${instagram}`]));
    expect(keys(cal.canManage.entry)).not.toContain("address");
    const [board] = await propsOf<{ entry: { key: string }[] }>(WalkIns, "/admin/walk-ins");
    expect(keys(board.entry)).not.toContain("address");
    const sale = await m.checkout.openBlankSale(cv, actor);
    const [pos] = await propsOf<{ entry: { key: string }[] }>(Pos, "/admin/checkout/[saleId]", { saleId: sale.id });
    expect(keys(pos.entry)).not.toContain("address");
    const r = await createStaffAppointmentAction({
      shopId: cv,
      staffId: people.makenna,
      date: m.time.todayLocal(),
      startMin: 600,
      serviceId,
      addonIds: [],
      customer: { firstName: "Nell", phone: "(319) 555-7803" },
      details: { address: ADDRESS },
    });
    expect(r).toEqual({ ok: false, error: "You can't add a client's address" });
    expect(await byPhone("3195557803")).toBeUndefined();
    await as("owner");
    expect(await rule("address", "add", null, { roleKey: "front_desk", shopId: cv })).toMatchObject({ ok: true });
  });
});

describe("add and edit are their own rules", () => {
  it("without \"can add\", a phone can't be entered anywhere, and the forms don't offer it", async () => {
    const { createCustomerAction } = await import("@/app/admin/customers/actions");
    const { createStaffAppointmentAction } = await import("@/app/admin/calendar/actions");
    const { walkInAction } = await import("@/app/admin/walk-ins/actions");
    const { newClientAtCheckoutAction } = await import("@/app/admin/checkout/actions");
    const { NewClientForm } = await import("@/app/admin/customers/new/form");
    const { WalkIns } = await import("@/app/admin/walk-ins/walk-ins");
    await as("owner");
    expect(await rule("phone", "add", "deny", { roleKey: "front_desk", shopId: cv })).toMatchObject({ ok: true });
    await as("frontdesk");
    const denied = { ok: false, error: "You can't add a client's phone" };
    const phone = "(319) 555-7676";
    expect(await createCustomerAction({ firstName: "Ivy", lastName: "", phone, smsOptIn: false, emailOptIn: false, homeShopId: cv })).toEqual(denied);
    expect(await walkInAction({ shopId: cv, serviceId, name: "Ivy", phone, preferredStaffId: null })).toEqual(denied);
    const sale = await m.checkout.openBlankSale(cv, actor);
    expect(await newClientAtCheckoutAction(sale.id, { firstName: "Ivy", phone })).toEqual(denied);
    expect(
      await createStaffAppointmentAction({
        shopId: cv,
        staffId: people.makenna,
        date: m.time.todayLocal(),
        startMin: 600,
        serviceId,
        addonIds: [],
        customer: { firstName: "Ivy", phone },
      }),
    ).toEqual(denied);
    expect(await byPhone("3195557676")).toBeUndefined();
    expect(await createCustomerAction({ firstName: "Ivy", lastName: "Nophone", smsOptIn: false, emailOptIn: false, homeShopId: cv })).toMatchObject({ ok: true });

    const [form] = await propsOf<{ fields: { key: string }[] }>(NewClientForm, "/admin/customers/new");
    expect(form.fields.map((f) => f.key)).not.toContain("phone");
    expect(form.fields.map((f) => f.key)).toContain("address");
    const [board] = await propsOf<{ canAddPhone: boolean }>(WalkIns, "/admin/walk-ins");
    expect(board.canAddPhone).toBe(false);
    await as("owner");
    expect(await rule("phone", "add", null, { roleKey: "front_desk", shopId: cv })).toMatchObject({ ok: true });
  });

  it('without "can edit", a number on file can\'t be replaced, even with the same number, so a refusal confirms nothing', async () => {
    const { createCustomerAction, updateCustomerAction } = await import("@/app/admin/customers/actions");
    await as("owner");
    expect(await rule("phone", "edit", "deny", { roleKey: "front_desk" })).toMatchObject({ ok: true });
    await as("frontdesk");
    const made = await createCustomerAction({ firstName: "Sam", lastName: "Noedit", phone: "(319) 555-7777", smsOptIn: false, emailOptIn: false, homeShopId: cv });
    expect(made, "an empty field can still be filled in").toMatchObject({ ok: true });
    const id = made.ok ? made.data.id : "";
    const base = { firstName: "Sam", lastName: "Noedit", smsOptIn: false, emailOptIn: false, homeShopId: cv };
    const denied = { ok: false, error: "You can't change a client's phone once it's on file" };
    expect(await updateCustomerAction(id, { ...base, phone: "(319) 555-7777" })).toEqual(denied);
    expect(await updateCustomerAction(id, { ...base, phone: "(319) 555-7878" })).toEqual(denied);
    expect(await updateCustomerAction(id, { ...base, phone: "" })).toEqual(denied);
    expect((await client(id)).phone).toBe("+13195557777");
    expect(await updateCustomerAction(id, { ...base, lastName: "Noedit-Jones" })).toMatchObject({ ok: true });
    const p = await profile(id);
    expect(p.field("phone")).toMatchObject({ level: "masked", saved: true, canEdit: false });
  });

  it("a barber's notes edit can be taken away", async () => {
    const { updateNotesAction } = await import("@/app/admin/customers/actions");
    await as("owner");
    expect(await rule("notes", "edit", "deny", { roleKey: "barber" })).toMatchObject({ ok: true });
    await as("makenna");
    expect(await updateNotesAction(booked, "wiped")).toEqual({ ok: false, error: "You can't change a client's notes once it's on file" });
    expect((await client(booked)).notes).toBe(NOTE);
  });
});

describe("the brand portal", () => {
  it("add and edit rules take allow or deny, are audited with the setting, and nobody grants what they can't do", async () => {
    await as("owner");
    expect(await rule("phone", "add", "masked", { roleKey: "barber" })).toEqual({ ok: false, error: "Pick a level" });
    expect(await rule("phone", "view", "allow", { roleKey: "barber" })).toEqual({ ok: false, error: "Pick a level" });
    expect(await rule("ratings", "add", "allow", { roleKey: "barber" })).toMatchObject({ ok: false, error: expect.stringMatching(/rating tools/) });
    expect(await rule("email", "edit", "allow", { roleKey: "barber", shopId: cv })).toMatchObject({ ok: true });
    const [a] = (await m.db.db.select().from(m.schema.auditLog).where(eq(m.schema.auditLog.action, "client_data.rule"))).filter(
      (x) => (x.details as { field?: string }).field === "Email",
    );
    expect(a.details).toMatchObject({ field: "Email", setting: "Can edit", for: { role: "Barber" }, where: "Coralville", from: "inherit", to: "allow" });

    expect(await rule("phone", "add", "deny", { staff: "admin" })).toMatchObject({ ok: true });
    await as("admin");
    expect(await rule("phone", "add", "allow", { roleKey: "barber" })).toEqual({ ok: false, error: "You can't let anyone add a detail you can't add yourself" });
    expect(await rule("phone", "add", "deny", { roleKey: "barber" })).toMatchObject({ ok: true });

    await expect(
      m.db.db.insert(m.schema.clientFieldRules).values({ field: "phone", setting: "add", level: "full", roleId: roleIds.barber, staffId: null, shopId: cv }),
    ).rejects.toThrow();
  });

  it("the portal shows the add and edit settings, and what one person can enter", async () => {
    const { RuleCell } = await import("@/app/admin/client-data/editor");
    await as("owner");
    const cells = await propsOf<{ rule: { field: string; setting: string; roleId: string }; level: string | null; inherited: string }>(
      RuleCell,
      "/admin/client-data",
      {},
      { setting: "edit" },
    );
    expect(cells.find((c) => c.rule.field === "notes" && c.rule.roleId === roleIds.barber)).toMatchObject({ rule: { setting: "edit" }, level: "deny" });
    expect(cells.find((c) => c.rule.field === "phone" && c.rule.roleId === roleIds.front_desk)).toMatchObject({ level: "deny", inherited: "allow" });
    expect(cells.some((c) => c.rule.field === "ratings")).toBe(false);
    const who = await open("/admin/client-data", {}, { who: people.makenna });
    expect(who.text).toContain("can add, not edit");
  });
});
