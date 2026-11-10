/**
 * Client notes against a real database: the profile's notes field as the pinned record note; phone
 * numbers and emails taken out by the database whoever writes the row; cut notes with guard, style,
 * products and before/after photos; private notes for managers only, never a shop login; notes
 * following the client to every location with who wrote them, where and when; masked and hidden
 * notes; who may edit, pin and remove; the Squire importer bringing client and visit notes over;
 * the staff API; the calendar, checkout and the assistant; and a merge keeping them all.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Mods, actor, loadModules } from "./setup";
import { open, propsOf } from "./render";
import { signInAs } from "./session";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));
vi.mock("next/navigation", async (orig) => ({ ...(await orig<typeof import("next/navigation")>()), useRouter: () => ({ refresh() {}, push() {} }) }));

let m: Mods;
let notes: typeof import("@/server/client-notes");
let api: typeof import("@/server/client-notes-api");
type Ctx = import("@/server/auth/staff").StaffContext;
type Completion = import("@/server/assistant/providers").CompletionRequest;
type Provider = import("@/server/assistant/providers").Provider;

const LOGINS = ["owner", "michelle", "frontdesk", "makenna", "manager.moline", "kat", "coralville"] as const;
type Login = (typeof LOGINS)[number];
const people = {} as Record<Login, string>;
const shop: Record<string, string> = {};
let today: string;
let cutId: string;
let cutCents: number;
let seq = 0;
let slot = 0;

const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);
const s = () => m.schema;
const sql = (...a: Parameters<Mods["drizzle"]["sql"]>) => m.drizzle.sql(...a);
const rows = async <T>(q: ReturnType<typeof sql>) => (await m.db.db.execute(q)) as unknown as T[];

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

async function ctxAs(who: Login, at = "coralville"): Promise<Ctx> {
  await signInAs(people[who], shop[at]);
  const { getStaffContext } = await import("@/server/auth/staff");
  return (await getStaffContext())!;
}

async function client(o: { notes?: string; lastName?: string; firstName?: string } = {}) {
  const [c] = await m.db.db
    .insert(s().customers)
    .values({ firstName: o.firstName ?? "Nola", lastName: o.lastName ?? `Notetest${String.fromCharCode(97 + (seq++ % 26))}${seq}`, homeShopId: shop.coralville, notes: o.notes ?? null })
    .returning();
  return c;
}

/** Today's appointment before opening (so it never meets the seeded book). */
async function appt(customerId: string, staffId: string, at = "coralville", status: "checked_in" | "booked" = "checked_in") {
  const startsAt = m.time.zonedWallTime(today, 30 + 35 * slot++).toJSDate();
  const [a] = await m.db.db
    .insert(s().appointments)
    .values({
      code: `N${crypto.randomUUID().replace(/-/g, "").slice(0, 9).toUpperCase()}`,
      shopId: shop[at],
      staffId,
      customerId,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 30 * 60_000),
      status,
      source: "staff",
      estimateCents: cutCents,
    })
    .returning();
  if (at === "coralville") await m.db.db.insert(s().appointmentItems).values({ appointmentId: a.id, serviceId: cutId, kind: "service", name: "Ray'z Cut", priceCents: cutCents, durationMin: 30 });
  return a;
}

const noteRows = (customerId: string) => m.db.db.select().from(s().clientNotes).where(eq(s().clientNotes.customerId, customerId));
const fieldRule = async (staffId: string, setting: "view" | "edit", level: "masked" | "hidden" | "deny") =>
  (await m.db.db.insert(s().clientFieldRules).values({ field: "notes", setting, level, staffId }).returning())[0].id;
const dropRule = (id: string) => m.db.db.delete(s().clientFieldRules).where(eq(s().clientFieldRules.id, id));

/** Calls a route handler with the signed-in person's session. */
async function call(fn: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>, method: string, id: string, body?: object) {
  const res = await fn(new Request(`http://test/api/staff/${id}`, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }), {
    params: Promise.resolve({ id }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

beforeAll(async () => {
  m = await loadModules();
  notes = await import("@/server/client-notes");
  api = await import("@/server/client-notes-api");
  today = m.time.todayLocal();
  for (const x of await m.db.db.select().from(s().shops)) shop[x.slug] = x.id;
  for (const l of LOGINS) people[l] = (await m.db.db.query.staff.findFirst({ where: eq(s().staff.email, `${l}@rayz.test`) }))!.id;
  const svc = (await m.catalog.shopCatalog(shop.coralville)).find((x) => x.slug === "rayz-cut-shampoo")!;
  cutId = svc.id;
  cutCents = svc.priceCents;
}, 180_000);

afterAll(async () => {
  await m?.db.closeDb();
});

describe("contact details never stay in a note", () => {
  it("keeps the profile's notes field as a pinned profile note, with phone numbers and emails taken out by the database", async () => {
    const c = await client({ notes: "Skin fade, #2 on the sides. Call 319-555-8101 or mail nola@example.test" });
    const saved = (await m.db.db.query.customers.findFirst({ where: eq(s().customers.id, c.id) }))!;
    expect(saved.notes).toBe("Skin fade, #2 on the sides. Call [phone removed] or mail [email removed]");
    const [record] = await noteRows(c.id);
    expect(record).toMatchObject({ kind: "profile", pinned: true, source: "record", shopId: shop.coralville, body: saved.notes, deletedAt: null });

    await m.db.db.update(s().customers).set({ notes: "" }).where(eq(s().customers.id, c.id));
    expect((await noteRows(c.id))[0].deletedAt).not.toBeNull();
    await m.db.db.update(s().customers).set({ notes: "Back again" }).where(eq(s().customers.id, c.id));
    expect(await noteRows(c.id)).toEqual([expect.objectContaining({ body: "Back again", deletedAt: null, pinned: true })]);
  });

  it("redacts a note written straight to the table, in the text and the cut details, and leaves guard numbers and times alone", async () => {
    const c = await client();
    const [n] = await m.db.db
      .insert(s().clientNotes)
      .values({ customerId: c.id, kind: "visit", body: "1.5 guard, 3/4 fade at 10:30, (563) 555-0142", details: { guard: "#1 text 555-0143", style: "Taper", products: ["x@y.co"] } })
      .returning();
    expect(n.body).toBe("1.5 guard, 3/4 fade at 10:30, [phone removed]");
    expect(n.details).toEqual({ guard: "#1 text [phone removed]", style: "Taper", products: ["[email removed]"] });
  });
});

describe("writing notes", () => {
  let c: Awaited<ReturnType<typeof client>>;
  let visitId: string;

  beforeAll(async () => {
    c = await client({ firstName: "Nola", lastName: "Pemberton" });
    visitId = (await appt(c.id, people.makenna)).id;
  });

  it("a barber writes a cut note for her client's visit; a number she typed is removed and she's told", async () => {
    const ctx = await ctxAs("makenna");
    const r = await notes.addNote(ctx, c.id, {
      kind: "visit",
      body: "Text me at 319 555 0199 if running late",
      details: { guard: "#2 sides, #4 top", style: "Low taper", products: ["Matte clay"] },
      appointmentId: visitId,
      pinned: true,
    });
    expect(r.removed).toEqual(["phone"]);
    expect(r.note).toMatchObject({ kind: "visit", pinned: false, author: "Makenna", shop: "Coralville", appointmentId: visitId, canEdit: true, body: "Text me at [phone removed] if running late" });
    expect(r.note.credit).toBe(`Makenna · Coralville · ${m.time.formatDate(new Date(), "MMM d, yyyy")}`);
    expect(r.note.details).toEqual({ guard: "#2 sides, #4 top", style: "Low taper", products: ["Matte clay"] });
    const stored = await noteRows(c.id);
    expect(JSON.stringify(stored)).not.toMatch(/555 0199/);
    const [audit] = await rows<{ action: string }>(sql`select action from audit_log where entity_id = ${c.id} and action = 'client_note.add'`);
    expect(audit).toBeTruthy();
  });

  it("the desk pins a profile note; only managers write private notes, and never a shop login", async () => {
    const desk = await ctxAs("frontdesk");
    const pinned = await notes.addNote(desk, c.id, { kind: "profile", body: "Prefers quiet appointments", pinned: true });
    expect(pinned.note).toMatchObject({ pinned: true, shop: "Coralville", canEdit: true });
    await expect(notes.addNote(desk, c.id, { kind: "private", body: "x" })).rejects.toThrow(/private manager notes/);
    const login = await ctxAs("coralville");
    await expect(notes.addNote(login, c.id, { kind: "private", body: "x" })).rejects.toThrow(/private manager notes/);
    const michelle = await ctxAs("michelle");
    expect((await notes.addNote(michelle, c.id, { kind: "private", body: "Disputed a charge twice" })).note.credit).toMatch(/^Michelle · Coralville · /);

    const kinds = async (who: Login) => (await notes.listNotes(await ctxAs(who), c.id)).notes.map((n) => n.kind).sort();
    expect(await kinds("michelle")).toEqual(["private", "profile", "visit"]);
    for (const who of ["makenna", "frontdesk", "coralville"] as const) expect(await kinds(who)).toEqual(["profile", "visit"]);
    expect((await notes.listNotes(await ctxAs("coralville"), c.id)).canWrite).not.toContain("private");
    expect((await notes.listNotes(michelle, c.id)).notes[0]).toMatchObject({ pinned: true, body: "Prefers quiet appointments" });
  });

  it("refuses an empty note and another client's visit", async () => {
    const ctx = await ctxAs("makenna");
    await expect(notes.addNote(ctx, c.id, { kind: "profile", body: "   " })).rejects.toThrow();
    const other = await client();
    const theirs = await appt(other.id, people.makenna);
    await expect(notes.addNote(ctx, c.id, { kind: "visit", body: "Fade", appointmentId: theirs.id })).rejects.toThrow(/isn't this client's/);
  });

  it("follows the client to Moline: a barber there sees the Coralville notes, credited to where they were written, once the client is in her column", async () => {
    let kat = await ctxAs("kat", "moline");
    expect(await notes.reachesClient(kat, c.id)).toBe(false);
    await expect(notes.addNote(kat, c.id, { kind: "profile", body: "Hi" })).rejects.toThrow(/not found/i);
    await appt(c.id, people.kat, "moline", "booked");
    kat = await ctxAs("kat", "moline");
    expect(await notes.reachesClient(kat, c.id)).toBe(true);
    const list = await notes.listNotes(kat, c.id);
    expect(list.notes.map((n) => [n.kind, n.shop])).toEqual([
      ["profile", "Coralville"],
      ["visit", "Coralville"],
    ]);
    const brief = (await notes.briefsFor(kat, [c.id])).get(c.id)!;
    expect(brief).toMatchObject({ masked: false, count: 2, pinned: [expect.objectContaining({ body: "Prefers quiet appointments" })] });
    expect(brief.cut?.details).toMatch(/#2 sides/);
    expect(brief.cut?.credit).toMatch(/^Makenna · Coralville/);
  });

  it("the Moline manager finds any client and reads the private note from Coralville", async () => {
    const mm = await ctxAs("manager.moline", "moline");
    const list = await notes.listNotes(mm, c.id);
    expect(list.notes.find((n) => n.kind === "private")).toMatchObject({ body: "Disputed a charge twice", author: "Michelle", shop: "Coralville" });
  });

  describe("editing", () => {
    it("people change their own notes; edit_any is for managers, at the shop the note was written", async () => {
      const cut = (await noteRows(c.id)).find((n) => n.kind === "visit" && !n.deletedAt)!;
      await expect(notes.editNote(await ctxAs("frontdesk"), cut.id, { body: "Mine now" })).rejects.toThrow(/only change notes you wrote/);
      await expect(notes.editNote(await ctxAs("manager.moline", "moline"), cut.id, { body: "From Moline" })).rejects.toThrow(/shop you don't work at/);
      const byManager = await notes.editNote(await ctxAs("michelle"), cut.id, { body: "Low taper, keep the length on top" });
      expect(byManager.note).toMatchObject({ author: "Makenna", editedBy: "Michelle", body: "Low taper, keep the length on top" });
      const own = await notes.editNote(await ctxAs("makenna"), cut.id, { body: "Ask nola@pemberton.test about the beard", details: { guard: "#3 sides" } });
      expect(own.removed).toEqual(["email"]);
      expect(own.note).toMatchObject({ body: "Ask [email removed] about the beard", details: { guard: "#3 sides" } });

      const desk = await notes.listNotes(await ctxAs("frontdesk"), c.id);
      expect(desk.notes.map((n) => [n.kind, n.canEdit])).toEqual([
        ["profile", true],
        ["visit", false],
      ]);
    });

    it("a manager unpins a profile note, and a cut note can't be pinned", async () => {
      const list = (await noteRows(c.id)).filter((n) => !n.deletedAt);
      const p = list.find((n) => n.kind === "profile")!;
      const v = list.find((n) => n.kind === "visit")!;
      const michelle = await ctxAs("michelle");
      expect((await notes.editNote(michelle, p.id, { pinned: false })).note.pinned).toBe(false);
      expect((await notes.editNote(michelle, v.id, { pinned: true })).note.pinned).toBe(false);
      expect((await notes.briefsFor(michelle, [c.id])).get(c.id)!.pinned).toEqual([]);
      await notes.editNote(michelle, p.id, { pinned: true });
    });

    it("the record note follows the profile's entry rules and writes through to the profile", async () => {
      const r = await client({ notes: "Old record note" });
      const desk = await ctxAs("frontdesk");
      const record = (await notes.listNotes(desk, r.id)).notes[0];
      expect(record).toMatchObject({ source: "record", author: "Client record", canEdit: true });
      const edited = await notes.editNote(desk, record.id, { body: "New record note, mail r@x.test" });
      expect(edited.note).toMatchObject({ body: "New record note, mail [email removed]", editedBy: expect.any(String) });
      expect((await m.db.db.query.customers.findFirst({ where: eq(s().customers.id, r.id) }))!.notes).toBe("New record note, mail [email removed]");

      const deny = await fieldRule(people.frontdesk, "edit", "deny");
      try {
        const denied = await ctxAs("frontdesk");
        expect((await notes.listNotes(denied, r.id)).notes[0].canEdit).toBe(false);
        await expect(notes.editNote(denied, record.id, { body: "Again" })).rejects.toThrow(/once it's on file/);
      } finally {
        await dropRule(deny);
      }
      await notes.removeNote(await ctxAs("michelle"), record.id);
      expect((await m.db.db.query.customers.findFirst({ where: eq(s().customers.id, r.id) }))!.notes ?? "").toBe("");
      expect((await notes.listNotes(desk, r.id)).notes).toEqual([]);
    });

    it("removing a note takes it off the profile and the briefs", async () => {
      const r = await client();
      await appt(r.id, people.makenna);
      const ctx = await ctxAs("makenna");
      const { note } = await notes.addNote(ctx, r.id, { kind: "visit", body: "Bald fade", details: { guard: "0" } });
      await expect(notes.removeNote(await ctxAs("frontdesk"), note.id)).rejects.toThrow(/only change notes you wrote/);
      await notes.removeNote(ctx, note.id);
      expect((await notes.listNotes(ctx, r.id)).notes).toEqual([]);
      expect((await notes.briefsFor(ctx, [r.id])).get(r.id)).toBeUndefined();
      expect((await noteRows(r.id))[0]).toMatchObject({ deletedBy: people.makenna });
    });
  });
});

describe("before and after photos", () => {
  it("go on cut notes, four at most, and are served only to people who may read the note", async () => {
    const c = await client();
    await appt(c.id, people.makenna);
    const ctx = await ctxAs("makenna");
    const { note } = await notes.addNote(ctx, c.id, { kind: "visit", body: "Textured crop" });
    const { note: profile } = await notes.addNote(ctx, c.id, { kind: "profile", body: "Sensitive scalp" });
    await expect(notes.addNotePhoto(ctx, profile.id, "before", PNG)).rejects.toThrow(/Photos go on cut notes/);
    await expect(notes.addNotePhoto(ctx, note.id, "before", "data:text/html;base64,PGI+")).rejects.toThrow(/JPEG, PNG or WebP/);
    const shown = await notes.addNotePhoto(ctx, note.id, "before", PNG);
    expect(shown.photos).toEqual([{ id: expect.any(String), kind: "before", url: `/admin/notes/photos/${shown.photos[0].id}` }]);
    for (let i = 0; i < 3; i++) await notes.addNotePhoto(ctx, note.id, "after", PNG);
    await expect(notes.addNotePhoto(ctx, note.id, "after", PNG)).rejects.toThrow(/Up to 4 photos/);

    const { GET } = await import("@/app/admin/notes/photos/[id]/route");
    const get = () => GET(new Request("http://test/x"), { params: Promise.resolve({ id: shown.photos[0].id }) });
    await signInAs(people.makenna, shop.coralville);
    const ok = await get();
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("image/png");
    await signInAs(people.kat, shop.moline);
    expect((await get()).status).toBe(404);

    expect((await notes.removeNotePhoto(ctx, shown.photos[0].id)).photos).toHaveLength(3);
  });
});

describe("masked and hidden client notes", () => {
  it("masked shows only how many are on file; hidden shows nothing, and neither can write", async () => {
    const c = await client({ notes: "On file" });
    await appt(c.id, people.makenna);
    const rule = await fieldRule(people.makenna, "view", "masked");
    try {
      let ctx = await ctxAs("makenna");
      expect(await notes.listNotes(ctx, c.id)).toEqual({ mode: "count", count: 1, notes: [], canWrite: [] });
      expect((await notes.briefsFor(ctx, [c.id])).get(c.id)).toEqual({ pinned: [], cut: null, count: 1, masked: true });
      await expect(notes.addNote(ctx, c.id, { kind: "visit", body: "Fade" })).rejects.toThrow(/can't write client notes/);

      await m.db.db.update(s().clientFieldRules).set({ level: "hidden" }).where(eq(s().clientFieldRules.id, rule));
      ctx = await ctxAs("makenna");
      expect((await notes.listNotes(ctx, c.id)).mode).toBeNull();
      expect((await notes.briefsFor(ctx, [c.id])).size).toBe(0);
      expect((await call(api.getClientNotes, "GET", c.id)).status).toBe(403);
    } finally {
      await dropRule(rule);
    }
  });
});

describe("the staff API", () => {
  it("lists, adds, edits and removes notes with a staff session, and records the look", async () => {
    const c = await client({ notes: "Record note" });
    await appt(c.id, people.makenna);
    await signInAs(people.makenna, shop.coralville);
    const list = await call(api.getClientNotes, "GET", c.id);
    expect(list.status).toBe(200);
    expect(list.body).toMatchObject({ mode: "full", count: 1, canWrite: ["profile", "visit"], notes: [{ source: "record", body: "Record note" }] });
    const looks = await rows<{ notes: string }>(sql`select detail->>'notes' notes from client_access_log where customer_id = ${c.id} and staff_id = ${people.makenna}`);
    expect(looks).toContainEqual({ notes: "true" });

    const added = await call(api.postClientNote, "POST", c.id, { kind: "visit", body: "Mail a@b.co", details: { style: "Pompadour" } });
    expect(added.status).toBe(201);
    expect(added.body).toMatchObject({ removed: ["email"], note: { body: "Mail [email removed]", details: { style: "Pompadour" } } });
    const id = added.body.note.id as string;
    expect((await call(api.patchNote, "PATCH", id, { body: "Longer on top" })).body.note.body).toBe("Longer on top");
    expect((await call(api.postRemoveNote, "POST", id)).body).toEqual({ ok: true });
    expect((await call(api.getClientNotes, "GET", c.id)).body.count).toBe(1);

    const stranger = await client();
    expect((await call(api.getClientNotes, "GET", stranger.id)).status).toBe(404);
    await signInAs(people.kat, shop.moline);
    expect((await call(api.postClientNote, "POST", c.id, { kind: "profile", body: "Hi" })).status).toBe(404);
    await signInAs(null);
    expect((await call(api.getClientNotes, "GET", c.id)).status).toBe(401);
  });
});

describe("the Squire importer", () => {
  const run = (kind: "clients" | "appointments", csv: string) => m.importer.runImport(kind, csv, { dryRun: false, actor, now: new Date(), filename: `${kind}.csv` });
  let clientId: string;

  it("brings client notes over as the pinned profile note, credited to Squire, without contact details", async () => {
    await run("clients", 'Client ID,First Name,Last Name,Phone,Email,Location,Notes\nSQ-N9001,Quinn,Notesimport,(319) 555-6101,,Coralville,"Likes a #3 on top; cell 319-555-6199, quinn@example.test"\n');
    const c = (await m.db.db.query.customers.findFirst({ where: eq(s().customers.lastName, "Notesimport") }))!;
    clientId = c.id;
    expect(c.notes).toBe("Likes a #3 on top; cell [phone removed], [email removed]");
    const [note] = (await notes.listNotes(await ctxAs("michelle"), c.id)).notes;
    expect(note).toMatchObject({ kind: "profile", pinned: true, source: "record", author: "Squire", body: c.notes });
    expect(note.credit).toMatch(/^Squire · Coralville · /);
  });

  it("brings appointment notes over as that visit's cut note, dated the visit, once however often it's imported", async () => {
    const day = m.time.addDays(today, -20);
    const [y, mo, d] = day.split("-").map(Number);
    const csv = `Appointment ID,Date,Time,Location,Barber,Client ID,Client Name,Phone,Service,Price,Duration,Status,Notes\nSQA-N9001,${mo}/${d}/${y},10:00 AM,Coralville,Makenna,SQ-N9001,Quinn Notesimport,(319) 555-6101,Haircut w/ Shampoo,33.00,40,Checked Out,"#2 sides, scissor top; call 555-6123"\n`;
    await run("appointments", csv);
    await run("appointments", csv);
    const list = await notes.listNotes(await ctxAs("michelle"), clientId);
    const visits = list.notes.filter((n) => n.kind === "visit");
    expect(visits).toHaveLength(1);
    expect(visits[0]).toMatchObject({ source: "squire_visit", author: "Squire", shop: "Coralville", body: "#2 sides, scissor top; call [phone removed]", appointmentId: expect.any(String) });
    expect(visits[0].credit).toBe(`Squire · Coralville · ${m.time.formatDate(day, "MMM d, yyyy")}`);
    expect(m.time.localDateOf(visits[0].createdAt)).toBe(day);
  });
});

describe("where the client turns up", () => {
  let c: Awaited<ReturnType<typeof client>>;
  let visit: Awaited<ReturnType<typeof appt>>;

  beforeAll(async () => {
    c = await client({ notes: "Hard of hearing, face him when talking" });
    visit = await appt(c.id, people.makenna);
    await notes.addNote(await ctxAs("makenna"), c.id, { kind: "visit", body: "Skin fade", details: { guard: "#0.5 to #2", products: ["Pomade"] }, appointmentId: visit.id });
    await notes.addNote(await ctxAs("michelle"), c.id, { kind: "private", body: "Banned from the Moline shop", pinned: true });
  });

  it("on the calendar: the appointment carries the pinned notes and the latest cut note, private only for managers", async () => {
    const { DayCalendar } = await import("@/app/admin/calendar/day-calendar");
    const block = async (who: Login) => {
      await ctxAs(who);
      const [props] = await propsOf<{ data: import("@/server/calendar").DayCalendarData }>(DayCalendar, "/admin/calendar", {}, { date: today });
      return props.data.columns.flatMap((col) => col.appts).find((a) => a.id === visit.id)!.clientNotes!;
    };
    const desk = await block("frontdesk");
    expect(desk.pinned.map((p) => p.body)).toEqual(["Hard of hearing, face him when talking"]);
    expect(desk.cut).toMatchObject({ body: "Skin fade", details: expect.stringMatching(/#0\.5 to #2/), credit: expect.stringMatching(/^Makenna · Coralville/) });
    expect((await block("michelle")).pinned.map((p) => p.kind).sort()).toEqual(["private", "profile"]);
  });

  it("at checkout: the ticket shows the notes and offers a cut note for this visit", async () => {
    const { Pos } = await import("@/app/admin/checkout/[saleId]/pos");
    const sale = await m.checkout.openSaleForAppointment(visit.id, actor);
    await ctxAs("frontdesk");
    const [props] = await propsOf<Parameters<typeof Pos>[0]>(Pos, "/admin/checkout/[saleId]", { saleId: sale.id });
    expect(props.customer?.clientNotes?.pinned.map((p) => p.body)).toEqual(["Hard of hearing, face him when talking"]);
    expect(props.customer?.cutNote).toEqual({ appointmentId: visit.id });
    const page = await open("/admin/checkout/[saleId]", { saleId: sale.id });
    expect(page.text).not.toContain("Banned from the Moline shop");
  });

  it("on the profile: every note with its credit, private ones only for managers", async () => {
    await ctxAs("frontdesk");
    const desk = await open("/admin/customers/[id]", { id: c.id });
    expect(desk.text).toContain("Skin fade");
    expect(desk.text).toMatch(/Makenna · Coralville · /);
    expect(desk.text).not.toContain("Banned from the Moline shop");
    await ctxAs("michelle");
    expect((await open("/admin/customers/[id]", { id: c.id })).text).toContain("Banned from the Moline shop");
  });
});

describe("the assistant", () => {
  function scripted(...rounds: { name: string; args: Record<string, unknown> }[][]): Provider & { seen: Completion[] } {
    const seen: Completion[] = [];
    let i = 0;
    return {
      id: "openai",
      model: "test",
      retention: "test",
      seen,
      async complete(r) {
        seen.push(structuredClone(r));
        const calls = rounds[i++];
        return calls ? { text: null, toolCalls: calls.map((x, j) => ({ id: `c${i}-${j}`, ...x })) } : { text: "done", toolCalls: [] };
      },
    };
  }
  const toolResult = (p: { seen: Completion[] }) => (p.seen[p.seen.length - 1].messages.find((x) => x.role === "tool") as { content: string }).content;
  let c: Awaited<ReturnType<typeof client>>;

  beforeAll(async () => {
    await m.db.db.update(s().brandSettings).set({ assistant: { perMinute: 30, perDay: 1000 } });
    c = await client({ firstName: "Thaddeus", lastName: "Quillfeather", notes: "Allergic to talc, phone 319-555-4411" });
    await appt(c.id, people.makenna);
    await notes.addNote(await ctxAs("makenna"), c.id, { kind: "visit", body: "Mid fade", details: { guard: "#1 sides" } });
    await notes.addNote(await ctxAs("michelle"), c.id, { kind: "private", body: "Owes a no-show fee" });
  });

  afterAll(async () => {
    await m.db.db.delete(s().assistantConversations);
    await m.db.db.update(s().brandSettings).set({ assistant: {} });
  });

  it("is offered to people who see notes, and answers as they'd read the profile, never with contact details", async () => {
    const assistant = await import("@/server/assistant");
    const tools = await import("@/server/assistant/tools");
    const makenna = await ctxAs("makenna");
    expect((await tools.toolsFor(makenna, await assistant.loadAssistantSettings())).map((t) => t.name)).toContain("client_notes");
    const blind = { ...makenna, permissions: new Set([...makenna.permissions].filter((p) => p !== "notes.view")) } as Ctx;
    expect((await tools.toolsFor(blind, await assistant.loadAssistantSettings())).map((t) => t.name)).not.toContain("client_notes");

    const p = scripted([{ name: "client_notes", args: { client: "Thaddeus Quillfeather" } }]);
    const r = await assistant.askAssistant(makenna, { question: "What's Thaddeus's usual cut?" }, { provider: p });
    const result = toolResult(p);
    expect(result).toMatch(/Mid fade/);
    expect(result).toMatch(/#1 sides/);
    expect(result).toMatch(/Allergic to talc/);
    expect(result).not.toMatch(/Owes a no-show fee|555-4411/);
    expect(JSON.stringify(p.seen)).not.toContain("555-4411");
    expect(result).not.toContain("Quillfeather");
    expect(r.messages[1].cards[0]).toMatchObject({ kind: "report", title: "Notes: Thaddeus Q." });

    const q = scripted([{ name: "client_notes", args: { client: "Thaddeus Quillfeather", kind: "private" } }]);
    await assistant.askAssistant(await ctxAs("michelle"), { question: "Any private notes on Thaddeus?" }, { provider: q });
    expect(toolResult(q)).toMatch(/Owes a no-show fee/);
    expect(toolResult(q)).not.toMatch(/Mid fade/);

    const k = scripted([{ name: "client_notes", args: { client: "Thaddeus Quillfeather" } }]);
    await assistant.askAssistant(await ctxAs("kat", "moline"), { question: "Notes on Thaddeus?" }, { provider: k });
    expect(toolResult(k)).toMatch(/No client they can see/);
  });
});

describe("merging clients", () => {
  it("brings the dropped client's notes along and keeps one record note", async () => {
    const keep = await client({ notes: "Keep this" });
    const drop = await client({ notes: "And this" });
    const michelle = await ctxAs("michelle");
    await notes.addNote(michelle, drop.id, { kind: "visit", body: "Flat top" });
    await m.customers.mergeCustomers(keep.id, drop.id, actor);
    const list = await notes.listNotes(michelle, keep.id);
    expect(list.notes.filter((n) => n.source === "record")).toHaveLength(1);
    expect(list.notes.find((n) => n.source === "record")!.body).toMatch(/Keep this[\s\S]*And this/);
    expect(list.notes.find((n) => n.kind === "visit")).toMatchObject({ body: "Flat top" });
    expect(await noteRows(drop.id)).toEqual([]);
  });
});
