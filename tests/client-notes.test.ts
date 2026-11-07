import { describe, expect, it } from "vitest";
import {
  ClientNoteSchema,
  CLIENT_NOTES_OPENAPI,
  NoteInputSchema,
  type NoteViewer,
  canChangeNote,
  cleanDetails,
  contactPatterns,
  contactWarning,
  creditLine,
  detailsLine,
  emptyNoteProblem,
  notePhotoProblem,
  notesMode,
  redactContact,
  writableKinds,
} from "@/domain/client-notes";
import { stubPlan } from "@/domain/assistant";
import { FEATURE_PERMISSIONS, ROLE_TEMPLATES, SHOP_LOGIN_NEVER, templateFor } from "@/domain/permissions";

const viewer = (o: Partial<NoteViewer> = {}): NoteViewer => ({ staffId: "me", view: true, write: true, editAny: false, private: false, shopIds: ["cv"], level: "full", ...o });

describe("contact details never stay in a note", () => {
  const phones = ["(319) 555-1234", "+1 319-555-1234", "3195551234", "319.555.1234", "319 555 1234", "1-319-555-1234", "555-1234", "555.1234"];
  it.each(phones)("finds and removes the phone number %s", (p) => {
    const text = `Call him at ${p} before`;
    expect(contactPatterns(text)).toEqual(["phone"]);
    expect(redactContact(text)).toBe("Call him at [phone removed] before");
  });

  it("finds and removes email addresses", () => {
    expect(contactPatterns("email bob.smith+cuts@gmail.com now")).toEqual(["email"]);
    expect(redactContact("email bob.smith+cuts@gmail.com or a@b.co")).toBe("email [email removed] or [email removed]");
  });

  it("both at once, and the warning says so", () => {
    const kinds = contactPatterns("bob@x.com, 319-555-1234");
    expect(kinds).toEqual(["email", "phone"]);
    expect(contactWarning(kinds)).toMatch(/a phone number and an email address.*removed when you save/);
    expect(contactWarning(["phone"])).toMatch(/^This looks like a phone number\./);
    expect(contactWarning([])).toBeNull();
  });

  it.each(["#2 sides, #4 top", "1.5 guard, 3/4 top", "Paid $25.00 on 2026-10-24", "SKU 012345678905", "room 101-2020x", "v1.2.3-4567", "555-1234-99", "555 1234", "Fade at 10:30"])(
    "leaves cut details alone: %s",
    (t) => {
      expect(contactPatterns(t)).toEqual([]);
      expect(redactContact(t)).toBe(t);
    },
  );
});

describe("cut notes", () => {
  it("details are trimmed, de-duplicated and dropped when empty", () => {
    expect(cleanDetails({ guard: "  #2 sides ", style: "", products: [" Clay", "Clay", " "] })).toEqual({ guard: "#2 sides", products: ["Clay"] });
    expect(cleanDetails({ guard: " ", products: [] })).toBeNull();
    expect(detailsLine({ guard: "#2 sides, #4 top", style: "Low fade", products: ["Pomade", "Sea salt spray"] })).toBe("#2 sides, #4 top · Low fade · Pomade, Sea salt spray");
  });

  it("a note needs text, or for a cut note its details", () => {
    expect(emptyNoteProblem("profile", "  ", null)).toBe("Write the note first");
    expect(emptyNoteProblem("visit", "", { guard: "#2" })).toBeNull();
    expect(emptyNoteProblem("visit", "", null)).toMatch(/guard, style or products/);
    expect(NoteInputSchema.safeParse({ kind: "visit", body: "x".repeat(2001) }).success).toBe(false);
    expect(NoteInputSchema.safeParse({ kind: "secret", body: "x" }).success).toBe(false);
  });

  it("photos are small JPEG, PNG or WebP data URLs", () => {
    expect(notePhotoProblem("data:image/jpeg;base64,AAAA")).toBeNull();
    expect(notePhotoProblem("data:image/gif;base64,AAAA")).toMatch(/JPEG, PNG or WebP/);
    expect(notePhotoProblem(`data:image/png;base64,${"A".repeat(400_000)}`)).toMatch(/300 KB/);
    expect(notePhotoProblem("javascript:alert(1)")).not.toBeNull();
  });
});

describe("who sees and changes notes", () => {
  it("in full, as a count when client notes are masked, or not at all", () => {
    expect(notesMode(viewer())).toBe("full");
    expect(notesMode(viewer({ level: "masked" }))).toBe("count");
    expect(notesMode(viewer({ level: "hidden" }))).toBeNull();
    expect(notesMode(viewer({ view: false }))).toBeNull();
  });

  it("private notes are written only with private manager notes; nothing is written without seeing notes in full", () => {
    expect(writableKinds(viewer())).toEqual(["profile", "visit"]);
    expect(writableKinds(viewer({ private: true }))).toEqual(["profile", "visit", "private"]);
    expect(writableKinds(viewer({ level: "masked" }))).toEqual([]);
    expect(writableKinds(viewer({ write: false, editAny: true }))).toEqual([]);
  });

  it("their own notes, or anyone's at their shops with edit anyone's", () => {
    const mine = { kind: "visit" as const, source: "staff" as const, authorStaffId: "me", shopId: "ic" };
    const theirs = { ...mine, authorStaffId: "other" };
    expect(canChangeNote(viewer(), mine)).toBe(true);
    expect(canChangeNote(viewer(), theirs)).toBe(false);
    expect(canChangeNote(viewer({ editAny: true }), theirs)).toBe(false);
    expect(canChangeNote(viewer({ editAny: true, shopIds: ["cv", "ic"] }), theirs)).toBe(true);
    expect(canChangeNote(viewer({ editAny: true, shopIds: null }), theirs)).toBe(true);
    expect(canChangeNote(viewer({ editAny: true }), { ...theirs, source: "squire_visit", authorStaffId: null, shopId: "cv" })).toBe(true);
    expect(canChangeNote(viewer({ private: false }), { ...mine, kind: "private" })).toBe(false);
    expect(canChangeNote(viewer({ level: "masked" }), mine)).toBe(false);
    expect(canChangeNote(viewer(), { kind: "profile", source: "record", authorStaffId: null, shopId: null })).toBe(true);
    expect(canChangeNote(viewer({ write: false }), { kind: "profile", source: "record", authorStaffId: null, shopId: null })).toBe(false);
  });

  it("credited with a first name, the location and the date; unsigned record notes to Squire or the client record", () => {
    const base = { source: "staff" as const, authorFirstName: "Makenna", authorLabel: null, shop: "Coralville", squire: false };
    expect(creditLine(base, "Oct 24, 2026")).toBe("Makenna · Coralville · Oct 24, 2026");
    expect(creditLine({ ...base, source: "record", authorFirstName: null, squire: true }, "Oct 1, 2026")).toBe("Squire · Coralville · Oct 1, 2026");
    expect(creditLine({ ...base, source: "record", authorFirstName: null, shop: null }, "Oct 1, 2026")).toBe("Client record · Oct 1, 2026");
    expect(creditLine({ ...base, source: "squire_visit", authorFirstName: null, authorLabel: "Squire" }, "Mar 3, 2025")).toBe("Squire · Coralville · Mar 3, 2025");
  });
});

describe("permissions", () => {
  it("are in the Clients group, and roles start with them as designed", () => {
    for (const k of ["notes.view", "notes.write", "notes.edit_any", "notes.private"]) expect(FEATURE_PERMISSIONS.find((p) => p.key === k)?.group).toBe("Clients");
    const has = (role: string, p: string) => templateFor(role)!.permissions.includes(p);
    for (const r of ["brand_admin", "regional_manager", "shop_manager"]) for (const p of ["notes.view", "notes.write", "notes.edit_any", "notes.private"]) expect(has(r, p), `${r} ${p}`).toBe(true);
    for (const r of ["front_desk", "shop_login", "barber"]) {
      expect(has(r, "notes.view") && has(r, "notes.write"), r).toBe(true);
      expect(has(r, "notes.private") || has(r, "notes.edit_any"), r).toBe(false);
    }
    expect(SHOP_LOGIN_NEVER.has("notes.private")).toBe(true);
    expect(ROLE_TEMPLATES.find((t) => t.key === "brand_owner")!.permissions).toContain("notes.private");
  });
});

describe("API and assistant", () => {
  it("the OpenAPI fragment describes the staff endpoints and the note shape", () => {
    expect(Object.keys(CLIENT_NOTES_OPENAPI.paths)).toEqual(["/staff/clients/{id}/notes", "/staff/notes/{id}", "/staff/notes/{id}/remove"]);
    expect(Object.keys(ClientNoteSchema.shape)).toEqual(expect.arrayContaining(["kind", "pinned", "body", "details", "author", "shop", "credit", "photos", "canEdit"]));
  });

  it("the dev stub sends notes questions to client_notes", () => {
    const o = { tools: ["run_report", "help", "client_notes"], reports: ["sales_summary"], shops: [], barbers: [] };
    expect(stubPlan("What are the notes for Marcus Reed?", o)).toEqual({ name: "client_notes", args: { client: "Marcus Reed", kind: "any" } });
    expect(stubPlan("What's Marcus Reed's usual cut?", o)).toEqual({ name: "client_notes", args: { client: "Marcus Reed", kind: "visit" } });
    expect(stubPlan("formula for #1042", o)).toEqual({ name: "client_notes", args: { client: "#1042", kind: "visit" } });
    expect(stubPlan("What are the notes for Marcus Reed?", { ...o, tools: ["run_report", "help"] })?.name).not.toBe("client_notes");
    expect(stubPlan("How do I add a note?", o)?.name).toBe("help");
  });
});
