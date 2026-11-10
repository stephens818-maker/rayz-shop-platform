import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { roles, shops, staff, staffAccessShops } from "@/db/schema";
import { Grantor, RoleDef, assignableRoles, staffEditDenied } from "@/domain/permissions";
import { staffPublicSlug } from "@/lib/ids";
import { Actor, audit } from "./audit";
import { accessState, loadStaffAccess } from "./auth/access";
import { AppError, forbidden } from "./errors";
import { Tenant, assertShop, requireInTenant } from "./tenant";

/**
 * Shop logins are shared accounts for one shop (its front desk, a back-office tablet): kind "shop",
 * scoped to exactly that shop, never bookable. Whoever holds logins.manage creates, disables and
 * resets them for the shops in their own access, and never with more access than they have.
 */
export interface LoginManager extends Tenant {
  actor: Actor;
  grantor: Grantor;
}

export interface ShopLoginRow {
  id: string;
  shopId: string;
  label: string;
  email: string | null;
  role: string;
  active: boolean;
  lastSignInAt: Date | null;
  createdAt: Date;
}

export async function listShopLogins(shopIds: readonly string[]): Promise<ShopLoginRow[]> {
  if (!shopIds.length) return [];
  return db
    .select({
      id: staff.id,
      shopId: staffAccessShops.shopId,
      label: staff.displayLabel,
      email: staff.email,
      role: roles.name,
      active: staff.active,
      lastSignInAt: staff.lastSignInAt,
      createdAt: staff.createdAt,
    })
    .from(staff)
    .innerJoin(staffAccessShops, eq(staffAccessShops.staffId, staff.id))
    .innerJoin(roles, eq(roles.id, staff.roleId))
    .where(and(eq(staff.kind, "shop"), inArray(staffAccessShops.shopId, [...shopIds])))
    .orderBy(asc(staff.displayLabel));
}

/** Roles a shop login may be given: one shop's worth, and nothing the manager doesn't have. */
export function shopLoginRoles<R extends RoleDef & { id: string; defaultScope: string }>(g: Grantor, all: R[]): R[] {
  return assignableRoles(g, all).filter((r) => r.defaultScope !== "all");
}

/** Readable, unambiguous, and long enough to type once at the front desk and then save. */
export function generatePassword(): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const bytes = randomBytes(12);
  const chars = [...bytes].map((b) => alphabet[b % alphabet.length]);
  return `${chars.slice(0, 4).join("")}-${chars.slice(4, 8).join("")}-${chars.slice(8).join("")}`;
}

export const NewShopLogin = z.object({
  shopId: z.uuid(),
  label: z.string().trim().min(1, "Give the login a name, like \u201cMoline front desk\u201d").max(24, "Keep the name to 24 characters"),
  email: z.email("Enter the email used to sign in").trim().toLowerCase(),
  roleId: z.uuid(),
});

export async function createShopLogin(m: LoginManager, raw: z.input<typeof NewShopLogin>) {
  const p = NewShopLogin.parse(raw);
  assertShop(m, p.shopId, "You can only add logins for your own shops");
  const role = shopLoginRoles(m.grantor, await db.select().from(roles)).find((r) => r.id === p.roleId);
  if (!role) throw forbidden("You can't give that role to a shop login");
  const shop = await db.query.shops.findFirst({ where: eq(shops.id, p.shopId) });
  if (!shop) throw new AppError("not_found", "Shop not found");
  if (await db.query.staff.findFirst({ where: eq(staff.email, p.email), columns: { id: true } })) throw new AppError("conflict", "That email is already used to sign in");
  const password = generatePassword();
  const id = await db.transaction(async (tx) => {
    const [{ n }] = await tx.select({ n: sql<number>`coalesce(max(substring(${staff.staffCode} from 3)::int), 0)::int` }).from(staff);
    const [row] = await tx
      .insert(staff)
      .values({
        kind: "shop",
        staffCode: `S-${String(n + 1).padStart(4, "0")}`,
        firstName: shop.name,
        displayLabel: p.label,
        publicSlug: staffPublicSlug(`${shop.slug}-desk`),
        email: p.email,
        roleId: role.id,
        shopScope: "one",
        isBookable: false,
        passwordHash: await bcrypt.hash(password, 10),
      })
      .returning({ id: staff.id });
    await tx.insert(staffAccessShops).values({ staffId: row.id, shopId: p.shopId });
    await audit(m.actor, "shop_login.create", "staff", row.id, { label: p.label, email: p.email, role: role.name }, p.shopId, tx);
    return row.id;
  });
  return { id, password };
}

async function loadShopLogin(m: LoginManager, id: string) {
  await requireInTenant(m, "staff", id);
  const target = await loadStaffAccess(id);
  const row = await db.query.staff.findFirst({ where: eq(staff.id, id) });
  if (!target || !row || row.kind !== "shop") throw new AppError("not_found", "Shop login not found");
  const denied = staffEditDenied(m.grantor, { ...accessState(target), workShopIds: [] });
  if (denied) throw forbidden(denied);
  return { row, shopId: target.shopIds[0] ?? null };
}

export async function setShopLoginActive(m: LoginManager, id: string, active: boolean) {
  const { row, shopId } = await loadShopLogin(m, id);
  if (row.active === active) return;
  await db
    .update(staff)
    .set(active ? { active } : { active, sessionsValidAfter: new Date() })
    .where(eq(staff.id, id));
  await audit(m.actor, active ? "shop_login.enable" : "shop_login.disable", "staff", id, { label: row.displayLabel }, shopId);
}

/** A new password, shown once; anyone signed in with the old one is signed out. A disabled login stays disabled. */
export async function resetShopLoginPassword(m: LoginManager, id: string) {
  const { row, shopId } = await loadShopLogin(m, id);
  const password = generatePassword();
  await db
    .update(staff)
    .set({ passwordHash: await bcrypt.hash(password, 10), sessionsValidAfter: new Date() })
    .where(eq(staff.id, id));
  await audit(m.actor, "shop_login.reset_password", "staff", id, { label: row.displayLabel }, shopId);
  return { password };
}
