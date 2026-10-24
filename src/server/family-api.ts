import "server-only";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { customers } from "@/db/schema";
import { body, json, options, route } from "./api";
import { customerActor } from "./audit";
import { requireCustomer } from "./auth/customer";
import { AppError } from "./errors";
import { addChild, detachChild, familyView, memberOf, updateChild } from "./family";
import { bookFamily } from "./family-booking";

/**
 * The family endpoints, shared by the web account page (/api/account/family/...) and the public API
 * (/api/v1/me/family/...). A child has no login: the signed-in parent manages them.
 */
async function parent(req: Request) {
  const id = await requireCustomer(req);
  const [c] = await db.select({ id: customers.id, firstName: customers.firstName, guardianId: customers.guardianId }).from(customers).where(eq(customers.id, id));
  if (!c) throw new AppError("unauthorized", "Sign in again");
  if (c.guardianId) throw new AppError("forbidden", "This is a child profile on a parent's account. The parent manages it.");
  return { id: c.id, actor: customerActor(c.firstName) };
}

const Id = z.object({ id: z.uuid() });

/** GET /me/family */
export const getFamily = route(async (req) => {
  const p = await parent(req);
  return json(await familyView(p.id));
});

/** POST /me/family/children */
export const postChild = route(async (req) => {
  const p = await parent(req);
  const raw = await body(req, z.unknown());
  const c = await addChild(p.id, raw, p.actor);
  return json(memberOf(await familyView(p.id), c.id), 201);
});

/** PATCH /me/family/children/{id} */
export const patchChild = route<{ id: string }>(async (req, params) => {
  const p = await parent(req);
  const { id } = Id.parse(params);
  await updateChild(id, await body(req, z.unknown()), p.actor, { guardianId: p.id });
  return json(memberOf(await familyView(p.id), id));
});

/** POST /me/family/children/{id}/remove */
export const removeChild = route<{ id: string }>(async (req, params) => {
  const p = await parent(req);
  const { id } = Id.parse(params);
  await detachChild(id, p.actor, { guardianId: p.id });
  return json(await familyView(p.id));
});

/** POST /me/family/bookings */
export const postFamilyBooking = route(async (req) => {
  const p = await parent(req);
  const raw = await body(req, z.unknown());
  const made = await bookFamily(raw, { guardianId: p.id, source: req.headers.get("x-client") === "web" ? "online" : "api", actor: p.actor });
  return json({ appointments: made }, 201);
});

export { options as OPTIONS };
