import "server-only";
import { z } from "zod";
import { body, json, options, route } from "./api";
import { can, getStaffContext } from "./auth/staff";
import { addNote, editNote, listNotes, reachesClient, removeNote } from "./client-notes";
import { recordClientAccess } from "./client-privacy";
import { AppError, forbidden, notFound } from "./errors";

/**
 * Client notes for a staff app, with a staff session: mounted at /api/staff/... here, and ready for
 * the mobile app's staff endpoints (CLIENT_NOTES_OPENAPI in src/domain/client-notes.ts).
 */
async function staffCtx() {
  const ctx = await getStaffContext();
  if (!ctx) throw new AppError("unauthorized", "Sign in required");
  if (!can(ctx, "notes.view")) throw forbidden("You can't see client notes");
  return ctx;
}

const Id = z.object({ id: z.uuid() });

/** GET /staff/clients/{id}/notes */
export const getClientNotes = route<{ id: string }>(async (_req, params) => {
  const ctx = await staffCtx();
  const { id } = Id.parse(params);
  if (!(await reachesClient(ctx, id))) throw notFound("Client");
  const list = await listNotes(ctx, id);
  if (!list.mode) throw forbidden("Client notes are hidden for you");
  await recordClientAccess(ctx, { kind: "view", customerId: id, detail: { notes: true } });
  return json(list);
});

/** POST /staff/clients/{id}/notes */
export const postClientNote = route<{ id: string }>(async (req, params) => {
  const ctx = await staffCtx();
  const { id } = Id.parse(params);
  return json(await addNote(ctx, id, await body(req, z.unknown())), 201);
});

/** PATCH /staff/notes/{id} */
export const patchNote = route<{ id: string }>(async (req, params) => {
  const ctx = await staffCtx();
  const { id } = Id.parse(params);
  return json(await editNote(ctx, id, await body(req, z.unknown())));
});

/** POST /staff/notes/{id}/remove */
export const postRemoveNote = route<{ id: string }>(async (_req, params) => {
  const ctx = await staffCtx();
  const { id } = Id.parse(params);
  return json(await removeNote(ctx, id));
});

export const OPTIONS = options;
