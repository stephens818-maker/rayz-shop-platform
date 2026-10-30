import { aliasedTable, and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { auditLog, roles, shops, staff, trustedDevices } from "@/db/schema";
import { type BrandNetworkSettings, NetworkRuleSchema, acceptsDevices, shopNetworkRule } from "@/domain/network-access";
import { OWNER_ROLE_KEY } from "@/domain/permissions";
import { Actor, audit, auditScope } from "./audit";
import { settingAt } from "./brand-sync/settings";
import { randomToken, sha256 } from "./auth/tokens";
import { AppError, forbidden } from "./errors";

/**
 * Managing where staff can sign in from: each location's rule (brand only), trusted devices
 * (managers at their shops, or the brand anywhere), and the blocked sign-ins the gate logged.
 */
export interface NetworkManager {
  actor: Actor;
  staffId: string;
  shopIds: string[];
  /** "Set where staff can sign in from": every shop's rule, and devices at any shop. */
  canSetRules: boolean;
  /** "Approve trusted devices" at their shops. */
  canApprove: boolean;
}

export async function shopRules(shopIds: readonly string[]) {
  if (!shopIds.length) return [];
  const rows = await db
    .select({ id: shops.id, name: shops.name, status: shops.status, rule: shops.networkAccess })
    .from(shops)
    .where(inArray(shops.id, [...shopIds]))
    .orderBy(asc(shops.name));
  return rows.map((r) => ({ id: r.id, name: r.name, status: r.status, rule: shopNetworkRule(r.rule) }));
}

export async function saveShopRule(m: NetworkManager, shopId: string, raw: z.input<typeof NetworkRuleSchema>) {
  if (!m.canSetRules) throw forbidden("Only the brand sets where staff can sign in from");
  const rule = NetworkRuleSchema.parse(raw);
  const shop = await db.query.shops.findFirst({ where: eq(shops.id, shopId), columns: { id: true, networkAccess: true } });
  if (!shop) throw new AppError("not_found", "Shop not found");
  const before = shopNetworkRule(shop.networkAccess);
  await db.update(shops).set({ networkAccess: { ...rule } }).where(eq(shops.id, shopId));
  await audit(m.actor, "network.rule", "shop", shopId, { before, after: rule }, shopId);
  return rule;
}

/** The blocked sign-in alert at a shop (the network setting); no shop, the brand's. */
export async function brandNetwork(shopId?: string | null): Promise<BrandNetworkSettings> {
  return settingAt<BrandNetworkSettings>("network", shopId);
}

const requester = aliasedTable(staff, "requester");
const decider = aliasedTable(staff, "decider");

export async function listTrustedDevices(shopIds: readonly string[]) {
  if (!shopIds.length) return [];
  return db
    .select({
      id: trustedDevices.id,
      shopId: trustedDevices.shopId,
      shop: shops.name,
      label: trustedDevices.label,
      status: trustedDevices.status,
      requestedBy: trustedDevices.requestedBy,
      requester: requester.displayLabel,
      requestedIp: trustedDevices.requestedIp,
      userAgent: trustedDevices.userAgent,
      decider: decider.displayLabel,
      decidedAt: trustedDevices.decidedAt,
      lastSeenAt: trustedDevices.lastSeenAt,
      lastIp: trustedDevices.lastIp,
      createdAt: trustedDevices.createdAt,
    })
    .from(trustedDevices)
    .innerJoin(shops, eq(shops.id, trustedDevices.shopId))
    .leftJoin(requester, eq(requester.id, trustedDevices.requestedBy))
    .leftJoin(decider, eq(decider.id, trustedDevices.decidedBy))
    .where(and(inArray(trustedDevices.shopId, [...shopIds]), inArray(trustedDevices.status, ["pending", "approved"])))
    .orderBy(asc(shops.name), desc(trustedDevices.createdAt));
}

const Label = z.string().trim().min(1, "Name the device, like \u201cFront desk iPad\u201d").max(40, "Keep the name to 40 characters");

/**
 * A row for this browser at a shop, pending or approved. A browser already holding a device cookie
 * keeps its secret (one cookie can count at several shops); otherwise a new secret is returned for
 * the cookie. A declined or removed row for the same browser and shop is reused.
 */
async function upsertDevice(v: {
  shopId: string;
  label: string;
  status: "pending" | "approved";
  requestedBy: string;
  decidedBy: string | null;
  ip: string | null;
  userAgent: string | null;
  existingHash: string | null;
}) {
  const secret = v.existingHash ? null : randomToken(32);
  const hash = v.existingHash ?? sha256(secret!);
  const [current] = await db
    .select()
    .from(trustedDevices)
    .where(and(eq(trustedDevices.tokenHash, hash), eq(trustedDevices.shopId, v.shopId)));
  if (current?.status === "approved") throw new AppError("conflict", "This device is already approved for that shop");
  if (current?.status === "pending" && v.status === "pending") throw new AppError("conflict", "This device is already waiting for a manager's approval");
  const values = {
    label: v.label,
    status: v.status,
    requestedBy: v.requestedBy,
    requestedIp: v.ip,
    userAgent: v.userAgent?.slice(0, 200) ?? null,
    decidedBy: v.decidedBy,
    decidedAt: v.decidedBy ? new Date() : null,
  };
  const [row] = current
    ? await db.update(trustedDevices).set(values).where(eq(trustedDevices.id, current.id)).returning({ id: trustedDevices.id })
    : await db
        .insert(trustedDevices)
        .values({ ...values, shopId: v.shopId, tokenHash: hash })
        .returning({ id: trustedDevices.id });
  return { id: row.id, secret };
}

/** After a blocked sign-in: this browser asks to be approved at one of the shops that blocked it. */
export async function requestDevice(v: { staffId: string; allowedShopIds: readonly string[]; shopId: string; label: string; ip: string | null; userAgent: string | null; existingHash: string | null }) {
  if (!v.allowedShopIds.includes(v.shopId)) throw forbidden("Sign in again from this device first");
  const label = Label.parse(v.label);
  const [shop, who] = await Promise.all([
    db.query.shops.findFirst({ where: eq(shops.id, v.shopId), columns: { name: true, networkAccess: true } }),
    db.query.staff.findFirst({ where: eq(staff.id, v.staffId), columns: { displayLabel: true } }),
  ]);
  if (!shop || !who) throw new AppError("not_found", "Shop not found");
  if (!acceptsDevices(shopNetworkRule(shop.networkAccess))) throw new AppError("bad_request", `${shop.name} only allows sign-in from its network, so approving a device won't help`);
  const d = await upsertDevice({ shopId: v.shopId, label, status: "pending", requestedBy: v.staffId, decidedBy: null, ip: v.ip, userAgent: v.userAgent, existingHash: v.existingHash });
  await audit({ staffId: v.staffId, label: who.displayLabel }, "device.request", "trusted_device", d.id, { label, shop: shop.name, ip: v.ip }, v.shopId);
  return { ...d, shop: shop.name };
}

function assertDeviceShop(m: NetworkManager, shopId: string) {
  if (!m.canSetRules && !m.canApprove) throw forbidden("You can't approve devices");
  if (!m.shopIds.includes(shopId)) throw forbidden("That device is for a shop outside yours");
}

/** A manager signed in on this browser approves it for one of their shops, at once. */
export async function trustThisDevice(m: NetworkManager, v: { shopId: string; label: string; ip: string | null; userAgent: string | null; existingHash: string | null }) {
  assertDeviceShop(m, v.shopId);
  const label = Label.parse(v.label);
  const d = await upsertDevice({ shopId: v.shopId, label, status: "approved", requestedBy: m.staffId, decidedBy: m.staffId, ip: v.ip, userAgent: v.userAgent, existingHash: v.existingHash });
  await audit(m.actor, "device.trust", "trusted_device", d.id, { label, ip: v.ip }, v.shopId);
  return d;
}

export type DeviceDecision = "approve" | "decline" | "revoke";

export async function decideDevice(m: NetworkManager, id: string, decision: DeviceDecision) {
  const [row] = await db.select().from(trustedDevices).where(eq(trustedDevices.id, id));
  if (!row) throw new AppError("not_found", "Device not found");
  assertDeviceShop(m, row.shopId);
  if (decision === "revoke" ? row.status !== "approved" : row.status !== "pending") throw new AppError("conflict", "That device has already been dealt with");
  if (decision === "approve" && row.requestedBy === m.staffId) throw forbidden("You can't approve a device you asked for. Ask another manager or the brand.");
  const status = decision === "approve" ? "approved" : decision === "decline" ? "declined" : "revoked";
  await db.update(trustedDevices).set({ status, decidedBy: m.staffId, decidedAt: new Date() }).where(eq(trustedDevices.id, id));
  await audit(m.actor, `device.${decision}`, "trusted_device", id, { label: row.label, requestedIp: row.requestedIp }, row.shopId);
}

/** Who's exempt: roles with "Can access remotely" (Brand Owner always), and people given it or denied it one by one. */
export async function remoteAccessHolders() {
  const rs = await db.select({ name: roles.name, key: roles.key, permissions: roles.permissions }).from(roles).orderBy(asc(roles.sortOrder), asc(roles.name));
  const people = await db
    .select({ id: staff.id, label: staff.displayLabel, overrides: staff.permissionOverrides })
    .from(staff)
    .where(and(eq(staff.active, true), sql`${staff.permissionOverrides} ? 'access.remote'`))
    .orderBy(asc(staff.displayLabel));
  return {
    roles: rs.filter((r) => r.key === OWNER_ROLE_KEY || r.permissions.includes("access.remote")).map((r) => r.name),
    granted: people.filter((p) => p.overrides["access.remote"] === true).map((p) => ({ id: p.id, label: p.label })),
    removed: people.filter((p) => p.overrides["access.remote"] === false).map((p) => ({ id: p.id, label: p.label })),
  };
}

/** Blocked and limited sign-ins the viewer may see, newest first. */
export async function blockedAttempts(viewer: { brandWide: boolean; currentShopId: string | null; shopIds: string[] }, limit = 100) {
  return db
    .select({ id: auditLog.id, at: auditLog.at, who: auditLog.actorLabel, staffId: auditLog.actorStaffId, shopId: auditLog.shopId, action: auditLog.action, details: auditLog.details })
    .from(auditLog)
    .where(and(inArray(auditLog.action, ["network.blocked", "network.limited"]), auditScope({ ...viewer, currentShopId: null })))
    .orderBy(desc(auditLog.at))
    .limit(limit);
}
