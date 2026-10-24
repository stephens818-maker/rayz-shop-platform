"use server";

import { revalidatePath } from "next/cache";
import type { NoteBrief, NoteEdit, NoteInput, NotePhotoKind } from "@/domain/client-notes";
import { safe } from "@/server/action";
import { authorize, requireStaff } from "@/server/auth/staff";
import { addNote, addNotePhoto, briefsFor, editNote, listNotes, reachesClient, removeNote, removeNotePhoto } from "@/server/client-notes";

const done = (customerId: string) => revalidatePath(`/admin/customers/${customerId}`);

export async function listNotesAction(customerId: string) {
  return safe(async () => listNotes(await authorize("notes.view"), customerId));
}

/** Pinned notes and the last cut for clients picked at check-in. */
export async function noteBriefsAction(customerIds: string[]) {
  return safe(async () => {
    const ctx = await requireStaff();
    const ids = customerIds.slice(0, 12);
    const reached = (await Promise.all(ids.map(async (id) => ((await reachesClient(ctx, id)) ? id : null)))).filter((x): x is string => !!x);
    return Object.fromEntries(await briefsFor(ctx, reached)) as Record<string, NoteBrief>;
  });
}

export async function addNoteAction(customerId: string, input: NoteInput) {
  return safe(async () => {
    const r = await addNote(await authorize(["notes.write"]), customerId, input);
    done(customerId);
    return r;
  });
}

export async function editNoteAction(customerId: string, noteId: string, patch: NoteEdit) {
  return safe(async () => {
    const r = await editNote(await authorize(["notes.write", "notes.edit_any"]), noteId, patch);
    done(customerId);
    return r;
  });
}

export async function removeNoteAction(customerId: string, noteId: string) {
  return safe(async () => {
    const r = await removeNote(await authorize(["notes.write", "notes.edit_any"]), noteId);
    done(customerId);
    return r;
  });
}

export async function addNotePhotoAction(customerId: string, noteId: string, kind: NotePhotoKind, dataUrl: string) {
  return safe(async () => {
    const r = await addNotePhoto(await authorize(["notes.write", "notes.edit_any"]), noteId, kind, dataUrl);
    done(customerId);
    return r;
  });
}

export async function removeNotePhotoAction(customerId: string, photoId: string) {
  return safe(async () => {
    const r = await removeNotePhoto(await authorize(["notes.write", "notes.edit_any"]), photoId);
    done(customerId);
    return r;
  });
}
