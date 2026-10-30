import { and, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, notificationJobs, roles, shops, staff, staffShops, trustedDevices, type TrustedDeviceStatus } from "@/db/schema";
import { BrandNetworkSettings, DEFAULT_NETWORK_RULE, GateShop, NetworkVerdict, ShopNetworkRule, blockedWhy, networkVerdict, shopNetworkRule } from "@/domain/network-access";
import { OWNER_ROLE_KEY } from "@/domain/permissions";
import { appBaseUrl } from "@/lib/deployment";
import { formatDateTime } from "@/lib/time";
import { audit } from "../audit";
import { StaffAccess, accessFor } from "./access";
import { sha256, signToken, verifyToken } from "./tokens";

/**
 * The sign-in restriction, enforced on every request: by the middleware before any admin page,
 * server action or download runs, by getStaffContext for the shops a session may touch, and at
 * sign-in. No server-only imports, so the middleware can load it.
 */

export const DEVICE_TTL = 400 * 86_400;
const TICKET_TTL = 15 * 60;
/** Blocked requests by the same person at the same shop from the same IP this close together are one attempt: a page and its prefetches. */
const SAME_ATTEMPT_MS = 60_000;
/** The brand is emailed at most this often per person and shop. */
const ALERT_EVERY_MS = 60 * 60_000;

export interface TrustedDevice {
  id: string;
  shopId: string;
  label: string;
  status: TrustedDeviceStatus;
}

/** The device rows this browser's signed cookie stands for, in any status, or null without a valid cookie. */
export async function devicesFromCookie(token: string | null | undefined): Promise<{ hash: string; rows: TrustedDevice[] } | null> {
  if (!token) return null;
  const p = await verifyToken<{ k?: unknown }>(token, "trusted_device");
  if (!p || typeof p.k !== "string" || p.k.length < 32) return null;
  const hash = sha256(p.k);
  const rows = await db
    .select({ id: trustedDevices.id, shopId: trustedDevices.shopId, label: trustedDevices.label, status: trustedDevices.status })
    .from(trustedDevices)
    .where(eq(trustedDevices.tokenHash, hash));
  return { hash, rows };
}

export const approvedShopIds = (d: { rows: TrustedDevice[] } | null) => (d ? d.rows.filter((r) => r.status === "approved").map((r) => r.shopId) : []);

export const deviceCookieValue = (secret: string) => signToken({ k: secret }, "trusted_device", DEVICE_TTL);

export async function touchDevices(hash: string, ip: string | null) {
  await db
    .update(trustedDevices)
    .set({ lastSeenAt: new Date(), lastIp: ip })
    .where(and(eq(trustedDevices.tokenHash, hash), eq(trustedDevices.status, "approved"), or(sql`${trustedDevices.lastSeenAt} is null`, lt(trustedDevices.lastSeenAt, new Date(Date.now() - 5 * 60_000)))));
}

const ruleOn = sql`${shops.networkAccess}->>'enabled' = 'true'`;

/** Whether any shop limits sign-in at all: the usual answer is no, and then nothing else is looked up. */
export async function anyRuleOn(): Promise<boolean> {
  const [r] = await db.select({ id: shops.id }).from(shops).where(ruleOn).limit(1);
  return !!r;
}

async function enabledRules(shopIds: readonly string[]): Promise<Map<string, ShopNetworkRule>> {
  if (!shopIds.length) return new Map();
  const rows = await db
    .select({ id: shops.id, rule: shops.networkAccess })
    .from(shops)
    .where(and(inArray(shops.id, [...shopIds]), ruleOn));
  return new Map(rows.map((r) => [r.id, shopNetworkRule(r.rule)]));
}

export interface RequestEvidence {
  ip: string | null;
  deviceShopIds: readonly string[];
}

/**
 * Which of this person's shops they can't reach from this request. Someone with no admin access to
 * any shop is held to the shops they work at. Exempt: the Brand Owner, and anyone whose role at
 * that shop (or personal override) has "Can access remotely".
 */
export async function evaluateNetwork(access: StaffAccess, e: RequestEvidence): Promise<NetworkVerdict> {
  const ids = access.shopIds.length
    ? access.shopIds
    : (await db.select({ id: staffShops.shopId }).from(staffShops).where(eq(staffShops.staffId, access.staffId))).map((r) => r.id);
  const rules = await enabledRules(ids);
  if (!rules.size) return { blocked: [], full: false };
  const gate: GateShop[] = ids.map((id) => ({
    shopId: id,
    rule: rules.get(id) ?? DEFAULT_NETWORK_RULE,
    exempt: access.isOwner || (access.byShop.get(id) ?? access).permissions.has("access.remote"),
  }));
  return networkVerdict(gate, e);
}

/** Proof, for 15 minutes, that this person's sign-in was just blocked at shops that accept approved devices. */
export async function deviceTicket(staffId: string, v: NetworkVerdict): Promise<string | null> {
  const shopIds = v.blocked.filter((b) => b.require !== "ip").map((b) => b.shopId);
  return shopIds.length ? signToken({ sub: staffId, shops: shopIds }, "device_request", TICKET_TTL) : null;
}

export async function readDeviceTicket(token: string | null | undefined): Promise<{ staffId: string; shopIds: string[] } | null> {
  if (!token) return null;
  const p = await verifyToken<{ sub?: unknown; shops?: unknown }>(token, "device_request");
  if (!p || typeof p.sub !== "string" || !Array.isArray(p.shops)) return null;
  return { staffId: p.sub, shopIds: p.shops.filter((s): s is string => typeof s === "string") };
}

export interface BlockedAttempt {
  staff: { id: string; displayLabel: string };
  roleName: string;
  verdict: NetworkVerdict;
  ip: string | null;
  /** sign_in: the password was right but the place wasn't. session: a signed-in request from the wrong place. */
  via: "sign_in" | "session";
  /** limited: signed in, but without the shops listed. */
  outcome?: "blocked" | "limited";
  path?: string | null;
  userAgent?: string | null;
  deviceIds?: string[];
}

/** People emailed about blocked sign-ins: the Brand Owner and anyone across all shops whose role sets the sign-in restriction. */
async function alertRecipients(except: string) {
  return db
    .select({ email: staff.email })
    .from(staff)
    .innerJoin(roles, eq(roles.id, staff.roleId))
    .where(
      and(
        eq(staff.active, true),
        eq(staff.kind, "person"),
        sql`${staff.email} is not null and ${staff.id} <> ${except}`,
        or(eq(roles.key, OWNER_ROLE_KEY), and(eq(staff.shopScope, "all"), sql`${roles.permissions} ? 'network.settings'`)),
      ),
    );
}

/**
 * Log a blocked attempt in the audit log, one entry per shop it was blocked at (so each shop's
 * managers see theirs), with who, the IP, the time and what was missing. Repeats within a minute
 * from the same IP are the same attempt. The brand is emailed when the alert is on, once an hour
 * per person and shop. Returns how many entries were written.
 */
export async function recordBlocked(a: BlockedAttempt): Promise<number> {
  const action = a.outcome === "limited" ? "network.limited" : "network.blocked";
  const ids = a.verdict.blocked.map((b) => b.shopId);
  if (!ids.length) return 0;
  const names = new Map((await db.select({ id: shops.id, name: shops.name }).from(shops).where(inArray(shops.id, ids))).map((s) => [s.id, s.name]));
  const actor = { staffId: a.staff.id, label: `${a.roleName}:${a.staff.displayLabel}` };
  const now = Date.now();
  const alerts: { shopId: string; why: string }[] = [];
  let written = 0;
  for (const b of a.verdict.blocked) {
    const [last] = await db
      .select({ at: auditLog.at, ip: sql<string | null>`${auditLog.details}->>'ip'` })
      .from(auditLog)
      .where(and(eq(auditLog.entity, "staff"), eq(auditLog.entityId, a.staff.id), eq(auditLog.action, action), eq(auditLog.shopId, b.shopId)))
      .orderBy(desc(auditLog.at))
      .limit(1);
    const since = last ? now - last.at.getTime() : Infinity;
    if (since < SAME_ATTEMPT_MS && last!.ip === a.ip) continue;
    const why = blockedWhy(b);
    await audit(
      actor,
      action,
      "staff",
      a.staff.id,
      {
        ip: a.ip,
        via: a.via,
        shop: names.get(b.shopId) ?? null,
        missing: why,
        require: b.require,
        path: a.path ?? null,
        device: a.deviceIds?.length ? a.deviceIds : null,
        userAgent: a.userAgent ? a.userAgent.slice(0, 200) : null,
      },
      b.shopId,
    );
    written++;
    if (action === "network.blocked" && since >= ALERT_EVERY_MS) alerts.push({ shopId: b.shopId, why });
  }
  if (!alerts.length) return written;
  const { settingFor } = await import("../brand-sync/settings");
  const alertAt = await settingFor<BrandNetworkSettings>("network", alerts.map((x) => x.shopId));
  const alerting = alerts.filter((x) => alertAt(x.shopId).alertOnBlock);
  alerts.splice(0, alerts.length, ...alerting);
  if (!alerts.length) return written;
  const to = (await alertRecipients(a.staff.id)).map((r) => r.email!);
  if (!to.length) return written;
  const who = a.staff.displayLabel;
  const when = formatDateTime(new Date(now));
  await db.insert(notificationJobs).values(
    alerts.flatMap(({ shopId, why }) =>
      to.map((email) => ({
        kind: "access_alert",
        channel: "email" as const,
        to: email,
        shopId,
        subject: `Ray'z: sign-in blocked at ${names.get(shopId) ?? "a shop"} (${who})`,
        body:
          `${who} tried to ${a.via === "sign_in" ? "sign in" : "keep working"} at ${names.get(shopId) ?? "a shop"} from ${a.ip ?? "an unknown address"} on ${when} and was blocked: ${why}. ` +
          `If that was them at the shop, add the shop's address or approve the device. Blocked sign-ins and devices: ${appBaseUrl()}/admin/sign-in-security`,
        runAt: new Date(now),
      })),
    ),
  );
  return written;
}

export type GateResult = { kind: "ok" } | { kind: "blocked"; ticket: string | null };
const OK: GateResult = { kind: "ok" };

/**
 * The middleware's check, on every admin request. A session that can't reach any of its shops from
 * here is refused and logged. One that can reach some goes on, and getStaffContext drops the rest.
 * Missing or bad sessions go on too: the page itself sends them to sign in.
 */
export async function gateRequest(r: { sessionToken: string; deviceToken?: string | null; ip: string | null; path?: string | null; userAgent?: string | null }): Promise<GateResult> {
  if (!(await anyRuleOn())) return OK;
  const p = await verifyToken<{ sub?: unknown }>(r.sessionToken, "staff_session");
  if (!p || typeof p.sub !== "string") return OK;
  const [row] = await db
    .select({ s: staff, r: roles })
    .from(staff)
    .innerJoin(roles, eq(roles.id, staff.roleId))
    .where(and(eq(staff.id, p.sub), eq(staff.active, true)));
  if (!row) return OK;
  const access = await accessFor(row.s, row.r);
  const device = await devicesFromCookie(r.deviceToken);
  if (device) await touchDevices(device.hash, r.ip);
  const verdict = await evaluateNetwork(access, { ip: r.ip, deviceShopIds: approvedShopIds(device) });
  if (!verdict.full) return OK;
  await recordBlocked({
    staff: row.s,
    roleName: row.r.name,
    verdict,
    ip: r.ip,
    via: "session",
    path: r.path,
    userAgent: r.userAgent,
    deviceIds: device?.rows.map((d) => d.id),
  });
  return { kind: "blocked", ticket: await deviceTicket(row.s.id, verdict) };
}
