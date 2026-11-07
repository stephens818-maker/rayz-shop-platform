import "server-only";
import { and, asc, desc, eq, gte, inArray, isNull, ne, notInArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db, type DBorTx } from "@/db";
import { appointments, clientNotePhotos, clientNotes, customerSquireIds, customers, shops, staff } from "@/db/schema";
import {
  type ClientNoteView,
  type ContactKind,
  type CutDetails,
  NOTE_KIND_LABEL,
  NOTE_PHOTOS_MAX,
  type NoteBrief,
  type NoteKind,
  NoteEditSchema,
  NoteInputSchema,
  type NotePhotoKind,
  type NoteSource,
  type NoteViewer,
  type NotesMode,
  canChangeNote,
  cleanDetails,
  contactPatterns,
  creditLine,
  detailsLine,
  emptyNoteProblem,
  noteAuthor,
  notePhotoProblem,
  notesMode,
  redactContact,
  seesKind,
  writableKinds,
} from "@/domain/client-notes";
import { formatDate } from "@/lib/time";
import { audit } from "./audit";
import { can, type StaffContext } from "./auth/staff";
import { type ClientPolicy, clientPolicy, entered } from "./client-privacy";
import { customerAccess } from "./customers";
import { AppError, forbidden, notFound } from "./errors";
import { stampRecordNote } from "./record-note";

export { stampRecordNote };
export type { NoteBrief };

/**
 * Client notes, brand-wide: whoever sees a client sees their notes, from every location, as far as
 * notes.view and Client data protection's "Client notes" level let them. Private notes need
 * notes.private. Contact details never go into a note: they're taken out here (so the person is
 * told) and again by trigger (core_0057_client_notes.sql), whoever writes the row.
 */

export const noteViewer = (ctx: StaffContext, policy: Pick<ClientPolicy, "level">): NoteViewer => ({
  staffId: ctx.staff.id,
  view: can(ctx, "notes.view"),
  write: can(ctx, "notes.write"),
  editAny: can(ctx, "notes.edit_any"),
  private: can(ctx, "notes.private"),
  shopIds: ctx.brandWide ? null : ctx.shopIds,
  level: policy.level("notes"),
});

const LIVE = ["cancelled", "no_show"] as const;

/**
 * Whether they reach this client's notes: a client they may look up (customerAccess), or one
 * booked at their shop from yesterday on, in their own column unless they run the calendar.
 */
export async function reachesClient(ctx: StaffContext, customerId: string, now = new Date()): Promise<boolean> {
  if (await customerAccess({ staffId: ctx.staff.id, viewAll: can(ctx, "clients.view_all") }, customerId)) return true;
  if (!ctx.shopIds.length) return false;
  const [hit] = await db
    .select({ id: appointments.id })
    .from(appointments)
    .where(
      and(
        eq(appointments.customerId, customerId),
        inArray(appointments.shopId, ctx.shopIds),
        notInArray(appointments.status, [...LIVE]),
        gte(appointments.startsAt, new Date(now.getTime() - 86_400_000)),
        can(ctx, "calendar.manage") ? undefined : eq(appointments.staffId, ctx.staff.id),
      ),
    )
    .limit(1);
  return !!hit;
}

const author = alias(staff, "note_author");
const editor = alias(staff, "note_editor");

const noteColumns = {
  n: clientNotes,
  authorFirst: author.firstName,
  editorFirst: editor.firstName,
  shop: shops.name,
};

function noteQuery(tx: DBorTx = db) {
  return tx
    .select(noteColumns)
    .from(clientNotes)
    .leftJoin(author, eq(author.id, clientNotes.authorStaffId))
    .leftJoin(editor, eq(editor.id, clientNotes.updatedBy))
    .leftJoin(shops, eq(shops.id, clientNotes.shopId));
}
type NoteRow = Awaited<ReturnType<typeof noteQuery>>[number];

const DAY = "MMM d, yyyy";
const kindFilter = (v: NoteViewer) => (v.private ? undefined : ne(clientNotes.kind, "private"));

async function squireClients(ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const rows = await db.selectDistinct({ id: customerSquireIds.customerId }).from(customerSquireIds).where(inArray(customerSquireIds.customerId, ids));
  return new Set(rows.map((r) => r.id));
}

const creditOf = (r: NoteRow, squire: boolean) => ({ source: r.n.source as NoteSource, authorFirstName: r.authorFirst, authorLabel: r.n.authorLabel, shop: r.shop, squire });
const credit = (r: NoteRow, squire: boolean) => creditLine(creditOf(r, squire), formatDate(r.n.createdAt, DAY));

function view(r: NoteRow, v: NoteViewer, squire: boolean, photos: { id: string; kind: NotePhotoKind }[], recordEditable: boolean): ClientNoteView {
  const n = r.n;
  const ref = { kind: n.kind, source: n.source as NoteSource, authorStaffId: n.authorStaffId, shopId: n.shopId };
  return {
    id: n.id,
    kind: n.kind,
    pinned: n.pinned,
    body: n.body,
    details: (n.details as CutDetails | null) ?? null,
    appointmentId: n.appointmentId,
    source: ref.source,
    author: noteAuthor(creditOf(r, squire)),
    shop: r.shop,
    createdAt: n.createdAt.toISOString(),
    updatedAt: n.updatedAt.toISOString(),
    credit: credit(r, squire),
    edited: n.updatedAt.getTime() - n.createdAt.getTime() > 60_000,
    editedBy: n.updatedBy && n.updatedBy !== n.authorStaffId ? r.editorFirst : null,
    canEdit: canChangeNote(v, ref) && (ref.source !== "record" || recordEditable),
    photos: photos.map((p) => ({ ...p, url: `/admin/notes/photos/${p.id}` })),
  };
}

export interface NotesList {
  mode: NotesMode;
  count: number;
  notes: ClientNoteView[];
  canWrite: NoteKind[];
}

/** A client's notes as this person may see them: pinned first, then newest. */
export async function listNotes(ctx: StaffContext, customerId: string): Promise<NotesList> {
  const policy = await clientPolicy(ctx);
  const v = noteViewer(ctx, policy);
  const mode = notesMode(v);
  if (!mode) return { mode, count: 0, notes: [], canWrite: [] };
  const where = and(eq(clientNotes.customerId, customerId), isNull(clientNotes.deletedAt), kindFilter(v));
  if (mode === "count") {
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(clientNotes).where(where);
    return { mode, count: n, notes: [], canWrite: [] };
  }
  const rows = await noteQuery().where(where).orderBy(desc(clientNotes.pinned), desc(clientNotes.createdAt));
  const [squire, photos] = await Promise.all([squireClients([customerId]), photosOf(rows.map((r) => r.n.id))]);
  const recordEditable = policy.canEdit("notes");
  return {
    mode,
    count: rows.length,
    notes: rows.map((r) => view(r, v, squire.has(customerId), photos.get(r.n.id) ?? [], recordEditable)),
    canWrite: writableKinds(v),
  };
}

async function photosOf(noteIds: string[]) {
  const out = new Map<string, { id: string; kind: NotePhotoKind }[]>();
  if (!noteIds.length) return out;
  const rows = await db
    .select({ id: clientNotePhotos.id, noteId: clientNotePhotos.noteId, kind: clientNotePhotos.kind })
    .from(clientNotePhotos)
    .where(inArray(clientNotePhotos.noteId, noteIds))
    .orderBy(asc(clientNotePhotos.createdAt));
  for (const p of rows) out.set(p.noteId, [...(out.get(p.noteId) ?? []), { id: p.id, kind: p.kind }]);
  return out;
}

async function oneNote(ctx: StaffContext, noteId: string) {
  const policy = await clientPolicy(ctx);
  const v = noteViewer(ctx, policy);
  const [r] = await noteQuery().where(and(eq(clientNotes.id, noteId), isNull(clientNotes.deletedAt)));
  if (!r || notesMode(v) !== "full" || !seesKind(v, r.n.kind) || !(await reachesClient(ctx, r.n.customerId))) throw notFound("Note");
  return { r, v, policy };
}

async function shownNote(ctx: StaffContext, noteId: string): Promise<ClientNoteView> {
  const { r, v, policy } = await oneNote(ctx, noteId);
  const [squire, photos] = await Promise.all([squireClients([r.n.customerId]), photosOf([r.n.id])]);
  return view(r, v, squire.has(r.n.customerId), photos.get(r.n.id) ?? [], policy.canEdit("notes"));
}

/** Contact details out of the text and the cut details, and which kinds were there. */
function cleaned(body: string, details: CutDetails | null) {
  const removed = new Set<ContactKind>(contactPatterns(body));
  const out = details ? { ...details } : null;
  if (out) {
    for (const k of contactPatterns([out.guard, out.style, ...(out.products ?? [])].join("\n"))) removed.add(k);
    if (out.guard) out.guard = redactContact(out.guard);
    if (out.style) out.style = redactContact(out.style);
    if (out.products) out.products = out.products.map(redactContact);
  }
  return { body: redactContact(body.trim()), details: out, removed: [...removed] };
}

/** Where a note is written: the visit's shop, the shop they're in, or the client's home shop if it's one of theirs. */
async function noteShop(ctx: StaffContext, customerId: string, appointmentShopId: string | null) {
  if (appointmentShopId) return appointmentShopId;
  if (ctx.currentShopId) return ctx.currentShopId;
  const [c] = await db.select({ home: customers.homeShopId }).from(customers).where(eq(customers.id, customerId));
  if (c?.home && (ctx.brandWide || ctx.shopIds.includes(c.home))) return c.home;
  return ctx.shopIds[0] ?? null;
}

export interface NoteSaved {
  note: ClientNoteView;
  removed: ContactKind[];
}

export async function addNote(ctx: StaffContext, customerId: string, raw: unknown): Promise<NoteSaved> {
  const input = NoteInputSchema.parse(raw);
  const policy = await clientPolicy(ctx);
  const v = noteViewer(ctx, policy);
  if (!(await reachesClient(ctx, customerId))) throw notFound("Client");
  if (!writableKinds(v).includes(input.kind)) {
    throw forbidden(input.kind === "private" ? "You can't write private manager notes" : "You can't write client notes");
  }
  const c = cleaned(input.body, input.kind === "visit" ? cleanDetails(input.details) : null);
  const problem = emptyNoteProblem(input.kind, c.body, c.details);
  if (problem) throw new AppError("bad_request", problem);
  let apptShop: string | null = null;
  if (input.appointmentId) {
    const [a] = await db.select({ shopId: appointments.shopId, customerId: appointments.customerId }).from(appointments).where(eq(appointments.id, input.appointmentId));
    if (!a || a.customerId !== customerId) throw new AppError("bad_request", "That visit isn't this client's");
    apptShop = a.shopId;
  }
  const shopId = await noteShop(ctx, customerId, apptShop);
  const [row] = await db
    .insert(clientNotes)
    .values({
      customerId,
      kind: input.kind,
      pinned: input.kind !== "visit" && !!input.pinned,
      body: c.body,
      details: c.details,
      appointmentId: input.kind === "visit" ? (input.appointmentId ?? null) : null,
      shopId,
      authorStaffId: ctx.staff.id,
      updatedBy: ctx.staff.id,
    })
    .returning({ id: clientNotes.id });
  await audit(ctx.actor, "client_note.add", "customer", customerId, { note: row.id, kind: NOTE_KIND_LABEL[input.kind], removed: c.removed }, shopId);
  return { note: await shownNote(ctx, row.id), removed: c.removed };
}

async function changeable(ctx: StaffContext, noteId: string) {
  const got = await oneNote(ctx, noteId);
  const n = got.r.n;
  if (!canChangeNote(got.v, { kind: n.kind, source: n.source as NoteSource, authorStaffId: n.authorStaffId, shopId: n.shopId })) {
    throw forbidden(got.v.editAny ? "That note was written at a shop you don't work at" : "You can only change notes you wrote");
  }
  return got;
}

/** Writes the profile's notes field; the trigger brings the record note along, and this stamps who. */
async function writeRecord(ctx: StaffContext, policy: ClientPolicy, customerId: string, next: string | null) {
  const [c] = await db.select({ notes: customers.notes }).from(customers).where(eq(customers.id, customerId));
  if (!c) throw notFound("Client");
  const value = entered(policy, "notes", c.notes, next ?? "");
  await db.transaction(async (tx) => {
    await tx.update(customers).set({ notes: value }).where(eq(customers.id, customerId));
    await stampRecordNote(tx, customerId, ctx.staff.id, null);
  });
}

export async function editNote(ctx: StaffContext, noteId: string, raw: unknown): Promise<NoteSaved> {
  const patch = NoteEditSchema.parse(raw);
  const { r, policy } = await changeable(ctx, noteId);
  const n = r.n;
  const details = n.kind === "visit" && patch.details !== undefined ? cleanDetails(patch.details) : ((n.details as CutDetails | null) ?? null);
  const c = cleaned(patch.body ?? n.body, details);
  const problem = emptyNoteProblem(n.kind, c.body, c.details);
  if (problem) throw new AppError("bad_request", problem);
  if (n.source === "record" && patch.body !== undefined && c.body !== n.body) await writeRecord(ctx, policy, n.customerId, c.body);
  const set: Partial<typeof clientNotes.$inferInsert> = {};
  if (n.source !== "record" && (c.body !== n.body || JSON.stringify(c.details) !== JSON.stringify(n.details ?? null))) Object.assign(set, { body: c.body, details: c.details });
  if (patch.pinned !== undefined && n.kind !== "visit" && patch.pinned !== n.pinned) set.pinned = patch.pinned;
  if (Object.keys(set).length) await db.update(clientNotes).set({ ...set, updatedAt: new Date(), updatedBy: ctx.staff.id }).where(eq(clientNotes.id, noteId));
  await audit(ctx.actor, "client_note.edit", "customer", n.customerId, { note: noteId, kind: NOTE_KIND_LABEL[n.kind], pinned: set.pinned, removed: c.removed }, n.shopId);
  return { note: await shownNote(ctx, noteId), removed: c.removed };
}

export async function removeNote(ctx: StaffContext, noteId: string): Promise<{ ok: true }> {
  const { r, policy } = await changeable(ctx, noteId);
  const n = r.n;
  if (n.source === "record") await writeRecord(ctx, policy, n.customerId, null);
  await db.update(clientNotes).set({ deletedAt: new Date(), deletedBy: ctx.staff.id }).where(eq(clientNotes.id, noteId));
  await audit(ctx.actor, "client_note.remove", "customer", n.customerId, { note: noteId, kind: NOTE_KIND_LABEL[n.kind] }, n.shopId);
  return { ok: true };
}

export async function addNotePhoto(ctx: StaffContext, noteId: string, kind: NotePhotoKind, dataUrl: string): Promise<ClientNoteView> {
  const { r } = await changeable(ctx, noteId);
  if (r.n.kind !== "visit") throw new AppError("bad_request", "Photos go on cut notes");
  if (kind !== "before" && kind !== "after") throw new AppError("bad_request", "Before or after?");
  const problem = notePhotoProblem(dataUrl);
  if (problem) throw new AppError("bad_request", problem);
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(clientNotePhotos).where(eq(clientNotePhotos.noteId, noteId));
  if (n >= NOTE_PHOTOS_MAX) throw new AppError("bad_request", `Up to ${NOTE_PHOTOS_MAX} photos on a note`);
  await db.insert(clientNotePhotos).values({ noteId, kind, dataUrl, createdBy: ctx.staff.id });
  await audit(ctx.actor, "client_note.photo_add", "customer", r.n.customerId, { note: noteId, kind }, r.n.shopId);
  return shownNote(ctx, noteId);
}

export async function removeNotePhoto(ctx: StaffContext, photoId: string): Promise<ClientNoteView> {
  const [p] = await db.select({ noteId: clientNotePhotos.noteId }).from(clientNotePhotos).where(eq(clientNotePhotos.id, photoId));
  if (!p) throw notFound("Photo");
  const { r } = await changeable(ctx, p.noteId);
  await db.delete(clientNotePhotos).where(eq(clientNotePhotos.id, photoId));
  await audit(ctx.actor, "client_note.photo_remove", "customer", r.n.customerId, { note: p.noteId }, r.n.shopId);
  return shownNote(ctx, p.noteId);
}

/** A before or after photo, for whoever may read its note. */
export async function notePhoto(ctx: StaffContext, photoId: string): Promise<string | null> {
  const [p] = await db.select({ noteId: clientNotePhotos.noteId, dataUrl: clientNotePhotos.dataUrl }).from(clientNotePhotos).where(eq(clientNotePhotos.id, photoId));
  if (!p) return null;
  try {
    await oneNote(ctx, p.noteId);
  } catch {
    return null;
  }
  return p.dataUrl;
}

// ───────────────────────────── On the calendar, Today, check-in and checkout ─────────────────────────────

/** What shows wherever the client turns up. Empty for people who don't see notes. */
export async function noteBriefs(v: NoteViewer, customerIds: readonly (string | null)[]): Promise<Map<string, NoteBrief>> {
  const ids = [...new Set(customerIds.filter((x): x is string => !!x))];
  const out = new Map<string, NoteBrief>();
  const mode = notesMode(v);
  if (!mode || !ids.length) return out;
  const live = and(inArray(clientNotes.customerId, ids), isNull(clientNotes.deletedAt), kindFilter(v));
  const counts = await db.select({ id: clientNotes.customerId, n: sql<number>`count(*)::int` }).from(clientNotes).where(live).groupBy(clientNotes.customerId);
  const blank = (count: number): NoteBrief => ({ pinned: [], cut: null, count, masked: mode === "count" });
  for (const c of counts) out.set(c.id, blank(c.n));
  if (mode === "count" || !counts.length) return out;
  const [pinned, cuts, squire] = await Promise.all([
    noteQuery()
      .where(and(live, eq(clientNotes.pinned, true)))
      .orderBy(desc(clientNotes.createdAt)),
    db
      .selectDistinctOn([clientNotes.customerId], noteColumns)
      .from(clientNotes)
      .leftJoin(author, eq(author.id, clientNotes.authorStaffId))
      .leftJoin(editor, eq(editor.id, clientNotes.updatedBy))
      .leftJoin(shops, eq(shops.id, clientNotes.shopId))
      .where(and(live, eq(clientNotes.kind, "visit")))
      .orderBy(clientNotes.customerId, desc(clientNotes.createdAt)),
    squireClients(ids),
  ]);
  for (const r of pinned) {
    const b = out.get(r.n.customerId)!;
    b.pinned.push({ id: r.n.id, kind: r.n.kind, body: r.n.body, credit: credit(r, squire.has(r.n.customerId)) });
  }
  for (const r of cuts) {
    out.get(r.n.customerId)!.cut = { id: r.n.id, body: r.n.body, details: detailsLine(r.n.details as CutDetails | null), credit: credit(r, squire.has(r.n.customerId)) };
  }
  return out;
}

export async function briefsFor(ctx: StaffContext, customerIds: readonly (string | null)[]) {
  return noteBriefs(noteViewer(ctx, await clientPolicy(ctx)), customerIds);
}
