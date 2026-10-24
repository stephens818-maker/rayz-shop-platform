import "server-only";
import { and, desc, eq, gt, isNull, or } from "drizzle-orm";
import { db } from "@/db";
import { clientContactGrants, roles, shops, staff } from "@/db/schema";
import { CONTACT_GRANT_LABEL, ContactGrantKind, GrantCaller, grantChangeDenied, grantStatus } from "@/domain/contact-grants";
import { formatDate } from "@/lib/time";
import { audit } from "./audit";
import { StaffContext, can } from "./auth/staff";
import { clientListDenied, isBrandLevelViewer, seesFullContact } from "./client-privacy";
import { AppError, forbidden, notFound } from "./errors";

export const grantCaller = (ctx: StaffContext): GrantCaller => ({
  managesPrivacy: can(ctx, "clients.privacy") && isBrandLevelViewer(ctx),
  seesFullContact: seesFullContact(ctx),
  mayExport: can(ctx, "clients.export") && !clientListDenied(ctx),
});

/** Every grant, newest first, with who and where it's for. */
export async function listContactGrants(now: Date = new Date()) {
  const rows = await db
    .select({ g: clientContactGrants, person: staff.displayLabel, kindOfLogin: staff.kind, role: roles.name, shop: shops.name })
    .from(clientContactGrants)
    .leftJoin(staff, eq(staff.id, clientContactGrants.staffId))
    .leftJoin(roles, eq(roles.id, staff.roleId))
    .leftJoin(shops, eq(shops.id, clientContactGrants.shopId))
    .orderBy(desc(clientContactGrants.createdAt));
  return rows.map((r) => ({
    ...r.g,
    status: grantStatus(r.g, now),
    target: r.g.shopId ? `Everyone at ${r.shop ?? "a removed location"}` : r.person ? `${r.person}${r.kindOfLogin === "shop" ? " (shop login)" : r.role ? ` · ${r.role}` : ""}` : "Removed login",
  }));
}

export interface GrantInput {
  kind: ContactGrantKind;
  staffId: string | null;
  shopId: string | null;
  expiresAt: Date | null;
  note: string | null;
}

export async function giveContactGrant(ctx: StaffContext, p: GrantInput) {
  const denied = grantChangeDenied(grantCaller(ctx), p);
  if (denied) throw forbidden(denied);
  const person = p.staffId ? await db.query.staff.findFirst({ where: eq(staff.id, p.staffId), columns: { id: true, displayLabel: true, kind: true, removedAt: true } }) : null;
  if (p.staffId && (!person || person.removedAt)) throw notFound("Person");
  const shop = p.shopId ? await db.query.shops.findFirst({ where: eq(shops.id, p.shopId), columns: { id: true, name: true } }) : null;
  if (p.shopId && !shop) throw notFound("Location");
  const now = new Date();
  const same = await db.query.clientContactGrants.findFirst({
    where: and(
      eq(clientContactGrants.kind, p.kind),
      p.staffId ? eq(clientContactGrants.staffId, p.staffId) : eq(clientContactGrants.shopId, p.shopId!),
      isNull(clientContactGrants.revokedAt),
      or(isNull(clientContactGrants.expiresAt), gt(clientContactGrants.expiresAt, now)),
    ),
  });
  if (same) throw new AppError("conflict", `${person?.displayLabel ?? shop!.name} already has that. Revoke it first to change the end date.`);
  const target = person ? { person: person.displayLabel, ...(person.kind === "shop" ? { shopLogin: true } : {}) } : { location: shop!.name };
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(clientContactGrants)
      .values({ kind: p.kind, staffId: p.staffId, shopId: p.shopId, expiresAt: p.expiresAt, note: p.note, grantedBy: ctx.staff.id, grantedByLabel: ctx.actor.label })
      .returning({ id: clientContactGrants.id });
    await audit(
      ctx.actor,
      "client_contact.grant",
      "client_contact_grant",
      row.id,
      { what: CONTACT_GRANT_LABEL[p.kind], ...target, until: p.expiresAt ? formatDate(p.expiresAt, "MMM d, yyyy") : "until revoked", ...(p.note ? { note: p.note } : {}) },
      p.shopId,
      tx,
    );
    return row;
  });
}

/** Revoking needs only client data protection: taking access away never gives anyone more. */
export async function revokeContactGrant(ctx: StaffContext, id: string) {
  if (!grantCaller(ctx).managesPrivacy) throw forbidden("Only brand-level people who manage client data protection can give or revoke contact access");
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(clientContactGrants)
      .set({ revokedAt: new Date(), revokedBy: ctx.staff.id, revokedByLabel: ctx.actor.label })
      .where(and(eq(clientContactGrants.id, id), isNull(clientContactGrants.revokedAt)))
      .returning();
    if (!row) throw notFound("Grant");
    const [who] = row.staffId ? await tx.select({ label: staff.displayLabel }).from(staff).where(eq(staff.id, row.staffId)) : [];
    const [where] = row.shopId ? await tx.select({ name: shops.name }).from(shops).where(eq(shops.id, row.shopId)) : [];
    await audit(
      ctx.actor,
      "client_contact.revoke",
      "client_contact_grant",
      row.id,
      { what: CONTACT_GRANT_LABEL[row.kind], ...(row.shopId ? { location: where?.name ?? "removed" } : { person: who?.label ?? "removed" }), givenBy: row.grantedByLabel },
      row.shopId,
      tx,
    );
    return null;
  });
}
