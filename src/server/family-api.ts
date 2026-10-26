import "server-only";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { customers } from "@/db/schema";
import { body, json, options, route } from "./api";
import { assertSwitch } from "./app-switches";
import { customerActor } from "./audit";
import { requireCustomer } from "./auth/customer";
import { AppError } from "./errors";
import { SplitRequestSchema } from "@/domain/family";
import { addChild, detachChild, familyView, memberOf, splitChild, updateChild } from "./family";
import { bookFamily } from "./family-booking";
import { bookGroup, cancelGroup, groupRescheduleOptions, myGroup, planGroup, publicGroup, rescheduleGroup, upcomingGroups } from "./booking-groups";

/**
 * The family endpoints, shared by the web account page (/api/account/family/...) and the public API
 * (/api/v1/me/family/...). A child has no login: the signed-in parent manages them.
 */
async function parent(req: Request) {
  // The app's family switch (C12); the website's account page keeps working.
  if (new URL(req.url).pathname.startsWith("/api/v1/")) await assertSwitch("family");
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

/** POST /me/family/children/{id}/split */
export const splitChildAccount = route<{ id: string }>(async (req, params) => {
  const p = await parent(req);
  const { id } = Id.parse(params);
  await splitChild(id, await body(req, SplitRequestSchema), p.actor, { guardianId: p.id });
  return json(await familyView(p.id));
});

const source = (req: Request) => (req.headers.get("x-client") === "web" ? "online" : "api");

/** POST /me/family/bookings */
export const postFamilyBooking = route(async (req) => {
  const p = await parent(req);
  const raw = await body(req, z.unknown());
  const made = await bookFamily(raw, { guardianId: p.id, source: source(req), actor: p.actor, idempotencyKey: req.headers.get("idempotency-key") });
  return json({ appointments: made }, 201);
});

// ───────────────────────────── Booking the family together ─────────────────────────────

const Code = z.object({ code: z.string().trim().min(4).max(20) });

/** POST /me/family/booking-options: the slot finder's plans for one day. */
export const postGroupOptions = route(async (req) => {
  const p = await parent(req);
  return json(await planGroup(await body(req, z.unknown()), { guardianId: p.id }));
});

/** POST /me/family/booking-groups: book the option picked, all or nothing. */
export const postBookingGroup = route(async (req) => {
  const p = await parent(req);
  const g = await bookGroup(await body(req, z.unknown()), { guardianId: p.id, source: source(req), actor: p.actor, idempotencyKey: req.headers.get("idempotency-key") });
  return json(publicGroup(g), 201);
});

/** GET /me/family/booking-groups: the family's upcoming groups. */
export const listBookingGroups = route(async (req) => {
  const p = await parent(req);
  return json({ groups: (await upcomingGroups(p.id)).map(publicGroup) });
});

/** GET /me/family/booking-groups/{code} */
export const getBookingGroup = route<{ code: string }>(async (req, params) => {
  const p = await parent(req);
  return json(publicGroup(await myGroup(Code.parse(params).code, p.id)));
});

/** POST /me/family/booking-groups/{code}/cancel: everyone still booked. */
export const cancelBookingGroup = route<{ code: string }>(async (req, params) => {
  const p = await parent(req);
  return json(publicGroup(await cancelGroup(Code.parse(params).code, { actor: p.actor, byCustomer: true, customerId: p.id })));
});

/** POST /me/family/booking-groups/{code}/options: plans for moving everyone to another day. */
export const postGroupRescheduleOptions = route<{ code: string }>(async (req, params) => {
  const p = await parent(req);
  const b = await body(req, z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD"), after: z.string().optional() }));
  return json(await groupRescheduleOptions(Code.parse(params).code, b.date, { customerId: p.id, staff: false, after: b.after ?? null }));
});

/** POST /me/family/booking-groups/{code}/reschedule: move everyone to the option picked, all or nothing. */
export const rescheduleBookingGroup = route<{ code: string }>(async (req, params) => {
  const p = await parent(req);
  return json(publicGroup(await rescheduleGroup(Code.parse(params).code, await body(req, z.unknown()), { actor: p.actor, byCustomer: true, customerId: p.id })));
});

export { options as OPTIONS };
