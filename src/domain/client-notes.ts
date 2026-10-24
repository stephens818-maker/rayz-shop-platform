/**
 * Client notes, kept pure: the three kinds, who sees and changes which, contact details kept out of
 * them, the cut note's details and photos, how a note is credited, and the staff API's shapes.
 *
 * Notes belong to the client, not the shop: they're seen at every location the client visits, by
 * staff assigned there with "See client notes" and client notes shown in full under Client data
 * protection. Private notes are for people with "See and write private manager notes" only.
 */
import { z } from "zod";
import type { Level } from "./client-privacy";

export const NOTE_KINDS = ["profile", "visit", "private"] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];
export const NOTE_KIND_LABEL: Record<NoteKind, string> = { profile: "Profile note", visit: "Cut note", private: "Private manager note" };
export const NOTE_KIND_HINT: Record<NoteKind, string> = {
  profile: "About the client. Pinned profile notes show on their appointments and at check-in, at every location.",
  visit: "This visit's cut or formula: guard numbers, style, products used, and before and after photos.",
  private: "Only people with private manager notes see these.",
};
export type NoteSource = "staff" | "record" | "squire_visit";

export const NOTE_MAX = 2000;
export const NOTE_PHOTO_KINDS = ["before", "after"] as const;
export type NotePhotoKind = (typeof NOTE_PHOTO_KINDS)[number];
export const NOTE_PHOTOS_MAX = 4;
/** Data URLs, like the client photo: a 640px JPEG is well under this. */
export const NOTE_PHOTO_MAX_CHARS = 400_000;
const PHOTO = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/;

export function notePhotoProblem(dataUrl: string): string | null {
  if (!PHOTO.test(dataUrl) || dataUrl.length > NOTE_PHOTO_MAX_CHARS) return "Use a JPEG, PNG or WebP photo under 300 KB";
  return null;
}

// ───────────────────────────── Contact details ─────────────────────────────

/*
 * Same patterns as redact_contact_text in drizzle/core_0057_client_notes.sql; keep the two in step.
 * Email first, then numbers with an area code (optional +1, brackets, dots, dashes or spaces), then
 * 555-1234 style local numbers. Never inside a longer run of digits or letters, so guard numbers,
 * prices, dates and product codes stay.
 */
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const PHONE = /(?<![0-9A-Za-z+])(?:\+?1[ .-]?)?(?:\([0-9]{3}\) ?|[0-9]{3}[ .-]?)[0-9]{3}[ .-]?[0-9]{4}(?![0-9A-Za-z])/g;
const LOCAL_PHONE = /(?<![0-9A-Za-z.-])[0-9]{3}[.-][0-9]{4}(?![0-9A-Za-z]|[.-][0-9])/g;
export const EMAIL_REMOVED = "[email removed]";
export const PHONE_REMOVED = "[phone removed]";

export type ContactKind = "phone" | "email";

/** Contact details in a note as typed, for the warning under the box. */
export function contactPatterns(text: string | null | undefined): ContactKind[] {
  if (!text) return [];
  const out: ContactKind[] = [];
  const noEmail = text.replace(EMAIL, EMAIL_REMOVED);
  if (noEmail !== text) out.push("email");
  if (noEmail.replace(PHONE, PHONE_REMOVED).replace(LOCAL_PHONE, PHONE_REMOVED) !== noEmail) out.push("phone");
  return out;
}

export function redactContact(text: string): string {
  return text.replace(EMAIL, EMAIL_REMOVED).replace(PHONE, PHONE_REMOVED).replace(LOCAL_PHONE, PHONE_REMOVED);
}

export function contactWarning(kinds: readonly ContactKind[]): string | null {
  if (!kinds.length) return null;
  const what = kinds.length === 2 ? "a phone number and an email address" : kinds[0] === "phone" ? "a phone number" : "an email address";
  return `This looks like ${what}. Notes never hold contact details, so it's removed when you save. Contact details go in the client's profile.`;
}

// ───────────────────────────── Cut notes ─────────────────────────────

export const CutDetailsSchema = z.object({
  guard: z.string().trim().max(80, "Guard numbers: up to 80 characters").optional(),
  style: z.string().trim().max(120, "Style: up to 120 characters").optional(),
  products: z.array(z.string().trim().max(60, "Each product: up to 60 characters")).max(10, "Up to 10 products").optional(),
});
export type CutDetails = z.output<typeof CutDetailsSchema>;

/** Empty parts dropped; null when nothing is left. */
export function cleanDetails(d: CutDetails | null | undefined): CutDetails | null {
  if (!d) return null;
  const out: CutDetails = {};
  if (d.guard?.trim()) out.guard = d.guard.trim();
  if (d.style?.trim()) out.style = d.style.trim();
  const products = (d.products ?? []).map((p) => p.trim()).filter(Boolean);
  if (products.length) out.products = [...new Set(products)];
  return Object.keys(out).length ? out : null;
}

/** "#2 sides, #4 top · Low fade · Pomade, sea salt spray" */
export function detailsLine(d: CutDetails | null | undefined): string {
  if (!d) return "";
  return [d.guard, d.style, d.products?.join(", ")].filter(Boolean).join(" · ");
}

// ───────────────────────────── Input ─────────────────────────────

export const NoteInputSchema = z.object({
  kind: z.enum(NOTE_KINDS),
  body: z.string().max(NOTE_MAX, `Up to ${NOTE_MAX} characters`).default(""),
  pinned: z.boolean().optional(),
  details: CutDetailsSchema.nullish(),
  /** A cut note's visit. */
  appointmentId: z.uuid().nullish(),
});
export type NoteInput = z.input<typeof NoteInputSchema>;

export const NoteEditSchema = z.object({
  body: z.string().max(NOTE_MAX, `Up to ${NOTE_MAX} characters`).optional(),
  pinned: z.boolean().optional(),
  details: CutDetailsSchema.nullish(),
});
export type NoteEdit = z.input<typeof NoteEditSchema>;

/** A note needs something in it: text, or for a cut note, its details. */
export function emptyNoteProblem(kind: NoteKind, body: string, details: CutDetails | null): string | null {
  if (body.trim() || (kind === "visit" && details)) return null;
  return kind === "visit" ? "Write the cut note, or fill in the guard, style or products" : "Write the note first";
}

// ───────────────────────────── Who sees and changes what ─────────────────────────────

export interface NoteViewer {
  staffId: string;
  /** notes.view */
  view: boolean;
  /** notes.write */
  write: boolean;
  /** notes.edit_any */
  editAny: boolean;
  /** notes.private */
  private: boolean;
  /** Shops they work at, or null for access to all shops. */
  shopIds: readonly string[] | null;
  /** How Client data protection shows them client notes. */
  level: Level;
}

/** Notes in full, only how many are on file (client notes masked), or nothing at all. */
export type NotesMode = "full" | "count" | null;

export function notesMode(v: Pick<NoteViewer, "view" | "level">): NotesMode {
  if (!v.view || v.level === "hidden") return null;
  return v.level === "full" ? "full" : "count";
}

export const seesKind = (v: Pick<NoteViewer, "private">, kind: NoteKind) => kind !== "private" || v.private;

/** Kinds they may write. Writing a note needs seeing notes in full. */
export function writableKinds(v: NoteViewer): NoteKind[] {
  if (notesMode(v) !== "full" || !v.write) return [];
  return NOTE_KINDS.filter((k) => seesKind(v, k));
}

export interface NoteRef {
  kind: NoteKind;
  source: NoteSource;
  authorStaffId: string | null;
  shopId: string | null;
}

/**
 * Editing, pinning or removing: their own notes with "Write client notes"; anyone's written at one
 * of their shops (and Squire's) with "Edit anyone's". The record note is the profile's notes field,
 * so Client data protection's add and edit rules for client notes apply to it on top (in the server).
 */
export function canChangeNote(v: NoteViewer, n: NoteRef): boolean {
  if (notesMode(v) !== "full" || !seesKind(v, n.kind)) return false;
  if (n.source === "record") return v.write || v.editAny;
  if (v.write && n.authorStaffId === v.staffId) return true;
  if (!v.editAny) return false;
  return v.shopIds === null || n.shopId === null || v.shopIds.includes(n.shopId);
}

// ───────────────────────────── Credit ─────────────────────────────

export interface NoteCredit {
  source: NoteSource;
  authorFirstName: string | null;
  authorLabel: string | null;
  shop: string | null;
  /** The client has Squire IDs: an unsigned record note came from Squire. */
  squire: boolean;
}

/** Who wrote it: a staff member's first name, "Squire", or "Client record". */
export function noteAuthor(n: NoteCredit): string {
  if (n.authorFirstName) return n.authorFirstName;
  if (n.authorLabel) return n.authorLabel;
  if (n.source === "record") return n.squire ? "Squire" : "Client record";
  return "Staff";
}

/** "Makenna · Coralville · Oct 24, 2026" */
export function creditLine(n: NoteCredit, date: string): string {
  return [noteAuthor(n), n.shop, date].filter(Boolean).join(" · ");
}

// ───────────────────────────── Where the client turns up ─────────────────────────────

/** On the calendar, Today, check-in and checkout: pinned notes and the latest cut note. */
export interface NoteBrief {
  /** Pinned notes (private ones only for people who see them), newest first. */
  pinned: { id: string; kind: NoteKind; body: string; credit: string }[];
  /** The latest cut note. */
  cut: { id: string; body: string; details: string; credit: string } | null;
  count: number;
  /** Client notes are masked for them: only how many are on file. */
  masked: boolean;
}

// ───────────────────────────── API ─────────────────────────────

const NotePhotoSchema = z.object({ id: z.string(), kind: z.enum(NOTE_PHOTO_KINDS), url: z.string().describe("Staff session only") });

export const ClientNoteSchema = z.object({
  id: z.string(),
  kind: z.enum(NOTE_KINDS),
  pinned: z.boolean(),
  body: z.string(),
  details: CutDetailsSchema.nullable(),
  appointmentId: z.string().nullable(),
  source: z.enum(["staff", "record", "squire_visit"]),
  author: z.string().describe("First name, Squire, or Client record"),
  shop: z.string().nullable().describe("Where it was written"),
  createdAt: z.string(),
  updatedAt: z.string(),
  credit: z.string().describe('"Makenna · Coralville · Oct 24, 2026"'),
  edited: z.boolean(),
  editedBy: z.string().nullable(),
  canEdit: z.boolean(),
  photos: z.array(NotePhotoSchema),
});
export type ClientNoteView = z.output<typeof ClientNoteSchema>;

export const ClientNotesSchema = z.object({
  mode: z.enum(["full", "count"]).describe("count: client notes are masked for you; only how many are on file"),
  count: z.number().int(),
  notes: z.array(ClientNoteSchema),
  canWrite: z.array(z.enum(NOTE_KINDS)),
});

export const NoteSavedSchema = z.object({ note: ClientNoteSchema, removed: z.array(z.enum(["phone", "email"])).describe("Contact details taken out of what was sent") });

const errorRef = { content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } };
const ok = (ref: string) => ({ description: "OK", content: { "application/json": { schema: { $ref: `#/components/schemas/${ref}` } } } });
const idParam = [{ name: "id", in: "path", required: true, schema: { type: "string" } }];

/** For openApiDocument (src/server/openapi.ts): the staff app's client notes. Served by src/server/client-notes-api.ts with a staff session. */
export const CLIENT_NOTES_OPENAPI = {
  components: { ClientNote: ClientNoteSchema, ClientNotes: ClientNotesSchema, ClientNoteInput: NoteInputSchema, ClientNoteEdit: NoteEditSchema, ClientNoteSaved: NoteSavedSchema },
  paths: {
    "/staff/clients/{id}/notes": {
      get: {
        tags: ["Staff"],
        summary: "A client's notes from every location: pinned first, then newest. Private notes only with private manager notes",
        parameters: idParam,
        responses: { 200: ok("ClientNotes"), 403: { description: "Notes hidden for you", ...errorRef }, 404: { description: "Not a client you can see", ...errorRef } },
      },
      post: {
        tags: ["Staff"],
        summary: "Add a note. Phone numbers and email addresses are removed; `removed` says which",
        parameters: idParam,
        requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/ClientNoteInput" } } } },
        responses: { 201: ok("ClientNoteSaved"), 400: { description: "Empty or too long", ...errorRef }, 403: { description: "Can't write that kind", ...errorRef } },
      },
    },
    "/staff/notes/{id}": {
      patch: {
        tags: ["Staff"],
        summary: "Edit or pin a note: your own, or anyone's at your shops with edit anyone's notes",
        parameters: idParam,
        requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/ClientNoteEdit" } } } },
        responses: { 200: ok("ClientNoteSaved"), 403: { description: "Not yours to change", ...errorRef }, 404: { description: "No such note", ...errorRef } },
      },
    },
    "/staff/notes/{id}/remove": {
      post: {
        tags: ["Staff"],
        summary: "Remove a note",
        parameters: idParam,
        responses: { 200: { description: "Removed" }, 403: { description: "Not yours to change", ...errorRef }, 404: { description: "No such note", ...errorRef } },
      },
    },
  },
} as const;
