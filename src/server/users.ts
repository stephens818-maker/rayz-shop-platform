import "server-only";
import bcrypt from "bcryptjs";
import QRCode from "qrcode";
import { and, asc, eq, gt, inArray, isNull, ne, sql } from "drizzle-orm";
import { db, DBorTx } from "@/db";
import { clientContactGrants, roles, shops, staff, staffAccessShops, staffInvites } from "@/db/schema";
import {
  OWNER_ROLE_KEY,
  Overrides,
  ShopScope,
  UserAccessState,
  accessByShop,
  cleanExpiries,
  cleanOverrides,
  effectiveAccess,
  isBrandLevelPerson,
  liveOverrides,
  userAccessChangeDenied,
} from "@/domain/permissions";
import { todayLocal } from "@/lib/time";
import { seesStaffContact } from "@/domain/staff-contact";
import { AccountChange, AccountTarget, INVITE_TTL_DAYS, accountChangeDenied, accountStatus, passwordProblem } from "@/domain/users";
import { appBaseUrl } from "@/lib/deployment";
import { labelContainsSurname, staffPublicSlug } from "@/lib/ids";
import { open, seal } from "@/lib/secret-box";
import { groupedSecret, newTotpSecret, otpauthUri, verifyTotp } from "@/lib/totp";
import { audit } from "./audit";
import { accessState, activeOwnerCount, loadStaffAccess, workShopIds } from "./auth/access";
import { StaffContext, staffGrantor } from "./auth/staff";
import { randomToken, sha256 } from "./auth/tokens";
import { AppError, forbidden, notFound } from "./errors";
import { sendNow } from "./notifications/queue";
import { futureBookings } from "./offboarding";
import { roleFitProblem } from "./owner-entities";
import { inTenant } from "./tenant";

const DAY = 86_400_000;

/** Everything the account rules need about one user, or not found when they're outside the caller's shops. */
export async function accountOf(ctx: StaffContext, staffId: string) {
  if (!(await inTenant(ctx, "staff", staffId))) throw notFound("User");
  const row = await db.query.staff.findFirst({ where: eq(staff.id, staffId) });
  const access = row && (await loadStaffAccess(staffId));
  if (!row || !access) throw notFound("User");
  const target: AccountTarget = {
    ...accessState(access),
    kind: row.kind,
    status: accountStatus({ active: row.active, hasPassword: !!row.passwordHash, invitedAt: row.invitedAt, removedAt: row.removedAt }),
    workShopIds: await workShopIds(staffId),
  };
  return { row, access, target };
}

async function assertMay(ctx: StaffContext, staffId: string, change: AccountChange) {
  const a = await accountOf(ctx, staffId);
  const bookings = change === "deactivate" || change === "remove" ? (await futureBookings(staffId)).length : 0;
  const denied = accountChangeDenied(staffGrantor(ctx), a.target, change, { activeOwners: await activeOwnerCount(), upcomingBookings: bookings });
  if (denied) throw forbidden(denied);
  return a;
}

/** Brand portal users the caller may see: people, not shop logins, and not removed ones. */
export async function listUsers(ctx: StaffContext) {
  const [rows, links, invites] = await Promise.all([
    db
      .select({ s: staff, role: roles })
      .from(staff)
      .innerJoin(roles, eq(roles.id, staff.roleId))
      .where(and(eq(staff.kind, "person"), isNull(staff.removedAt)))
      .orderBy(asc(roles.sortOrder), asc(staff.displayLabel)),
    db.select({ staffId: staffAccessShops.staffId, shopId: shops.id, name: shops.name }).from(staffAccessShops).innerJoin(shops, eq(shops.id, staffAccessShops.shopId)),
    db
      .select({ staffId: staffInvites.staffId, expiresAt: staffInvites.expiresAt })
      .from(staffInvites)
      .where(and(isNull(staffInvites.usedAt), isNull(staffInvites.revokedAt), gt(staffInvites.expiresAt, new Date()))),
  ]);
  const viewer = { permissions: ctx.permissions, staffId: ctx.staff.id };
  const today = todayLocal();
  return rows
    .map(({ s, role }) => {
      const scope: ShopScope = role.key === OWNER_ROLE_KEY ? "all" : s.shopScope;
      const mine = links.filter((l) => l.staffId === s.id);
      const a = effectiveAccess(role, liveOverrides(cleanOverrides(s.permissionOverrides), cleanExpiries(s.permissionOverrideExpires), today), s.maxDiscountPct, scope);
      return {
        id: s.id,
        label: s.displayLabel,
        name: [s.firstName, s.lastName].filter(Boolean).join(" "),
        email: seesStaffContact(viewer, s.id) ? s.email : null,
        role: role.name,
        roleKey: role.key,
        scope,
        shops: mine,
        status: accountStatus({ active: s.active, hasPassword: !!s.passwordHash, invitedAt: s.invitedAt, removedAt: s.removedAt }),
        twoFactor: s.totpEnabledAt ? ("on" as const) : s.twoFactorRequired ? ("required" as const) : ("off" as const),
        remote: a.isOwner || a.permissions.has("access.remote"),
        brandLevel: isBrandLevelPerson({ kind: s.kind, scope, role }),
        lastSignInAt: s.lastSignInAt,
        inviteExpires: invites.find((i) => i.staffId === s.id)?.expiresAt ?? null,
      };
    })
    .filter((u) => ctx.brandWide || (u.scope !== "all" && u.roleKey !== OWNER_ROLE_KEY && u.shops.some((x) => ctx.shopIds.includes(x.shopId))));
}

async function createInvite(staffId: string, by: string, tx: DBorTx = db) {
  const token = randomToken(32);
  await tx.update(staffInvites).set({ revokedAt: new Date() }).where(and(eq(staffInvites.staffId, staffId), isNull(staffInvites.usedAt), isNull(staffInvites.revokedAt)));
  await tx.insert(staffInvites).values({ staffId, tokenHash: sha256(token), expiresAt: new Date(Date.now() + INVITE_TTL_DAYS * DAY), createdBy: by });
  return token;
}

/** The invite email. The outbox keeps it without the link; the link comes back only when the email couldn't go, for the inviter to pass on. */
async function sendInvite(p: { to: string; firstName: string; role: string; by: string; twoFactor: boolean }, token: string) {
  const link = `${appBaseUrl()}/invite/${token}`;
  const body = (l: string) =>
    [
      `Hi ${p.firstName},`,
      "",
      `${p.by} invited you to the Ray'z Barber Shop brand portal as ${p.role}.`,
      "",
      `Set your password here. The link works once, for ${INVITE_TTL_DAYS} days:`,
      l,
      ...(p.twoFactor ? ["", "You'll also set up two-step sign-in with an authenticator app on your phone."] : []),
      "",
      "If you weren't expecting this, you can ignore this email.",
    ].join("\n");
  const status = await sendNow({ kind: "staff_invite", channel: "email", to: p.to, subject: "Your Ray'z brand portal invite", body: body(link), storedBody: body("[sign-up link removed]") });
  return { delivered: status === "sent", link: status === "sent" ? null : link };
}

export interface InviteInput {
  firstName: string;
  lastName: string;
  displayLabel: string;
  email: string;
  roleId: string;
  scope: "all" | "selected";
  shopIds: string[];
  twoFactorRequired: boolean;
  remote: boolean;
}

/** Adds a user with a role and locations, and emails them a link to set their password. Nobody gives more than they have. */
export async function inviteUser(ctx: StaffContext, p: InviteInput) {
  const role = await db.query.roles.findFirst({ where: eq(roles.id, p.roleId) });
  if (!role) throw notFound("Role");
  const owner = role.key === OWNER_ROLE_KEY;
  const scope: ShopScope = owner || p.scope === "all" ? "all" : p.shopIds.length === 1 ? "one" : "selected";
  const shopIds = scope === "all" ? [] : [...new Set(p.shopIds)];
  if (shopIds.length) {
    const found = await db.select({ id: shops.id }).from(shops).where(inArray(shops.id, shopIds));
    if (found.length !== shopIds.length) throw notFound("Location");
  }
  const misfit = await roleFitProblem(role, scope, shopIds);
  if (misfit) throw new AppError("bad_request", misfit);
  const roleRemote = effectiveAccess(role, {}, null, scope).permissions.has("access.remote");
  const overrides: Overrides = owner || p.remote === roleRemote ? {} : { "access.remote": p.remote };
  const { union: next } = accessByShop(role, shopIds.map((shopId) => ({ shopId, role: null })), overrides, null, scope);
  const blank: UserAccessState = { staffId: "new", isOwner: false, permissions: new Set(), maxDiscountPct: 0, scope: "one", shopIds: [] };
  const denied = userAccessChangeDenied(
    staffGrantor(ctx),
    blank,
    { staffId: "new", ...next, scope, shopIds, overrides, brandLevel: isBrandLevelPerson({ kind: "person", scope, role }) },
    { activeOwners: await activeOwnerCount() },
  );
  if (denied) throw forbidden(denied);
  const email = p.email.trim().toLowerCase();
  if (await db.query.staff.findFirst({ where: sql`lower(${staff.email}) = ${email}`, columns: { id: true } })) throw new AppError("conflict", "Someone already signs in with that email");
  if (p.lastName && labelContainsSurname(p.displayLabel, p.lastName)) throw new AppError("bad_request", `The display label can be shown to customers, so it can't include the last name. Try "${p.firstName} ${p.lastName[0]}."`);
  const dup = await db.query.staff.findFirst({ where: and(sql`lower(${staff.displayLabel}) = lower(${p.displayLabel})`, eq(staff.active, true)), columns: { id: true } });
  if (dup) throw new AppError("conflict", `"${p.displayLabel}" is already used by someone else. Add an initial.`);

  const { id, token } = await db.transaction(async (tx) => {
    const [{ n }] = await tx.select({ n: sql<number>`coalesce(max(substring(${staff.staffCode} from 3)::int), 0)::int` }).from(staff);
    const [row] = await tx
      .insert(staff)
      .values({
        staffCode: `S-${String(n + 1).padStart(4, "0")}`,
        firstName: p.firstName,
        lastName: p.lastName || null,
        displayLabel: p.displayLabel,
        publicSlug: staffPublicSlug(p.firstName),
        email,
        roleId: role.id,
        shopScope: scope,
        permissionOverrides: overrides as Record<string, boolean>,
        isBookable: false,
        twoFactorRequired: p.twoFactorRequired,
        invitedAt: new Date(),
      })
      .returning({ id: staff.id });
    if (shopIds.length) await tx.insert(staffAccessShops).values(shopIds.map((shopId) => ({ staffId: row.id, shopId })));
    const token = await createInvite(row.id, ctx.staff.id, tx);
    await audit(
      ctx.actor,
      "user.invite",
      "staff",
      row.id,
      { name: p.displayLabel, role: role.name, scope, shops: shopIds.length ? shopIds : "all", twoFactorRequired: p.twoFactorRequired, remoteAccess: next.permissions.has("access.remote") || next.isOwner },
      null,
      tx,
    );
    return { id: row.id, token };
  });
  const sent = await sendInvite({ to: email, firstName: p.firstName, role: role.name, by: ctx.staff.displayLabel, twoFactor: p.twoFactorRequired }, token);
  return { staffId: id, ...sent };
}

export async function resendInvite(ctx: StaffContext, staffId: string) {
  const { row, access } = await assertMay(ctx, staffId, "invite");
  if (!row.email) throw new AppError("bad_request", "Add their email first");
  const token = await db.transaction(async (tx) => {
    const t = await createInvite(staffId, ctx.staff.id, tx);
    await audit(ctx.actor, "user.invite_resend", "staff", staffId, { name: row.displayLabel }, null, tx);
    return t;
  });
  return sendInvite({ to: row.email, firstName: row.firstName, role: access.role.name, by: ctx.staff.displayLabel, twoFactor: row.twoFactorRequired }, token);
}

export async function revokeInvite(ctx: StaffContext, staffId: string) {
  const { row } = await assertMay(ctx, staffId, "invite");
  const n = await db
    .update(staffInvites)
    .set({ revokedAt: new Date() })
    .where(and(eq(staffInvites.staffId, staffId), isNull(staffInvites.usedAt), isNull(staffInvites.revokedAt)))
    .returning({ id: staffInvites.id });
  if (!n.length) throw new AppError("conflict", "There's no open invite to cancel");
  await audit(ctx.actor, "user.invite_revoke", "staff", staffId, { name: row.displayLabel }, null);
  return null;
}

// ───────────────────────────── Accepting an invite ─────────────────────────────

/** An invite that can still be used, with the person it's for; null for a wrong, used, cancelled or expired link. */
export async function openInvite(token: string, now: Date = new Date()) {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
  const [r] = await db
    .select({ invite: staffInvites, person: staff })
    .from(staffInvites)
    .innerJoin(staff, eq(staff.id, staffInvites.staffId))
    .where(and(eq(staffInvites.tokenHash, sha256(token)), isNull(staffInvites.usedAt), isNull(staffInvites.revokedAt), gt(staffInvites.expiresAt, now)));
  if (!r || !r.person.active || r.person.removedAt || r.person.passwordHash || !r.person.email) return null;
  return r;
}

/** The authenticator key someone signing up sets up, sealed so the form can't swap it. */
export async function inviteEnrollment(inviteId: string, email: string) {
  const secret = newTotpSecret();
  return { sealed: seal(JSON.stringify({ i: inviteId, s: secret })), qr: await QRCode.toDataURL(otpauthUri(secret, email), { margin: 1, width: 192 }), secret: groupedSecret(secret) };
}

export async function acceptInvite(p: { token: string; password: string; sealed?: string | null; code?: string | null }, now: Date = new Date()) {
  const found = await openInvite(p.token, now);
  if (!found) throw new AppError("not_found", "This invite link has expired or was already used. Ask for a new one.");
  const { invite, person } = found;
  const problem = passwordProblem(p.password, person.email);
  if (problem) throw new AppError("bad_request", problem);
  let totp: { totpSecret: string; totpEnabledAt: Date; totpLastStep: number } | null = null;
  if (person.twoFactorRequired) {
    const sealed = p.sealed ? open(p.sealed) : null;
    const key = sealed ? (JSON.parse(sealed) as { i: string; s: string }) : null;
    if (!key || key.i !== invite.id) throw new AppError("bad_request", "Reload the page and scan the new code");
    const step = verifyTotp(key.s, p.code ?? "", { now });
    if (step === null) throw new AppError("bad_request", "That code didn't work. Check your authenticator app and try the newest code.");
    totp = { totpSecret: seal(key.s), totpEnabledAt: now, totpLastStep: step };
  }
  const hash = await bcrypt.hash(p.password, 10);
  await db.transaction(async (tx) => {
    const [used] = await tx
      .update(staffInvites)
      .set({ usedAt: now })
      .where(and(eq(staffInvites.id, invite.id), isNull(staffInvites.usedAt), isNull(staffInvites.revokedAt)))
      .returning({ id: staffInvites.id });
    if (!used) throw new AppError("conflict", "This invite link was already used");
    await tx
      .update(staff)
      .set({ passwordHash: hash, totpFailures: 0, totpLockedUntil: null, ...(totp ?? {}) })
      .where(and(eq(staff.id, person.id), isNull(staff.passwordHash)));
    await audit({ staffId: person.id, label: person.displayLabel }, "user.signup", "staff", person.id, { twoFactor: !!totp }, null, tx);
  });
  return { email: person.email! };
}

// ───────────────────────────── Status and sign-in ─────────────────────────────

/** Deactivating signs them out at once and keeps everything; reactivating lets them sign in again. */
export async function setUserActive(ctx: StaffContext, staffId: string, active: boolean) {
  const { row } = await assertMay(ctx, staffId, active ? "reactivate" : "deactivate");
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(staff)
      .set(active ? { active: true } : { active: false, sessionsValidAfter: now })
      .where(eq(staff.id, staffId));
    if (!active) await tx.update(staffInvites).set({ revokedAt: now }).where(and(eq(staffInvites.staffId, staffId), isNull(staffInvites.usedAt), isNull(staffInvites.revokedAt)));
    await audit(ctx.actor, active ? "user.reactivate" : "user.deactivate", "staff", staffId, { name: row.displayLabel }, null, tx);
  });
  return null;
}

/**
 * Removing keeps the record for history (sales, audit entries, payroll) but it never signs in again:
 * the login email, password, authenticator and PIN are cleared, open invites and contact access
 * grants are revoked, and it leaves every list.
 */
export async function removeUser(ctx: StaffContext, staffId: string) {
  const { row } = await assertMay(ctx, staffId, "remove");
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(staff)
      .set({
        active: false,
        isBookable: false,
        removedAt: now,
        sessionsValidAfter: now,
        email: null,
        passwordHash: null,
        totpSecret: null,
        totpEnabledAt: null,
        totpLastStep: null,
        clockPinHash: null,
        twoFactorRequired: false,
      })
      .where(eq(staff.id, staffId));
    await tx.update(staffInvites).set({ revokedAt: now }).where(and(eq(staffInvites.staffId, staffId), isNull(staffInvites.usedAt), isNull(staffInvites.revokedAt)));
    const grants = await tx
      .update(clientContactGrants)
      .set({ revokedAt: now, revokedBy: ctx.staff.id, revokedByLabel: ctx.actor.label })
      .where(and(eq(clientContactGrants.staffId, staffId), isNull(clientContactGrants.revokedAt)))
      .returning({ id: clientContactGrants.id });
    await audit(ctx.actor, "user.remove", "staff", staffId, { name: row.displayLabel, contactGrantsRevoked: grants.length }, null, tx);
  });
  return null;
}

/** Requiring two-step sign-in signs them out, so their next sign-in asks for a code (or sets one up). */
export async function setTwoFactorRequired(ctx: StaffContext, staffId: string, on: boolean) {
  const { row } = await assertMay(ctx, staffId, on ? "require_2fa" : "drop_2fa");
  if (row.twoFactorRequired === on) return null;
  await db.transaction(async (tx) => {
    await tx
      .update(staff)
      .set({ twoFactorRequired: on, ...(on && staffId !== ctx.staff.id && !row.totpEnabledAt ? { sessionsValidAfter: new Date() } : {}) })
      .where(eq(staff.id, staffId));
    await audit(ctx.actor, "user.two_factor", "staff", staffId, { name: row.displayLabel, required: on }, null, tx);
  });
  return null;
}

/** For a lost phone: their authenticator is forgotten and they're signed out; if it's required they set up a new one at sign-in. */
export async function resetTwoFactor(ctx: StaffContext, staffId: string) {
  const { row } = await assertMay(ctx, staffId, "reset_2fa");
  if (!row.totpEnabledAt) throw new AppError("conflict", "They haven't set up two-step sign-in");
  await db.transaction(async (tx) => {
    await tx
      .update(staff)
      .set({ totpSecret: null, totpEnabledAt: null, totpLastStep: null, totpFailures: 0, totpLockedUntil: null, sessionsValidAfter: new Date() })
      .where(eq(staff.id, staffId));
    await audit(ctx.actor, "user.two_factor_reset", "staff", staffId, { name: row.displayLabel }, null, tx);
  });
  return null;
}

export interface ProfileInput {
  firstName: string;
  lastName: string;
  displayLabel: string;
  email: string;
}

/** Name and sign-in email. Changing the email of someone who has signed up signs them out. */
export async function updateUserProfile(ctx: StaffContext, staffId: string, p: ProfileInput) {
  const { row } = await assertMay(ctx, staffId, "profile");
  const seesEmail = seesStaffContact({ permissions: ctx.permissions, staffId: ctx.staff.id }, staffId);
  const email = seesEmail ? p.email.trim().toLowerCase() : row.email;
  if (!email) throw new AppError("bad_request", "Add the email they sign in with");
  if (email !== row.email && (await db.query.staff.findFirst({ where: and(sql`lower(${staff.email}) = ${email}`, ne(staff.id, staffId)), columns: { id: true } })))
    throw new AppError("conflict", "Someone else already signs in with that email");
  if (p.lastName && labelContainsSurname(p.displayLabel, p.lastName)) throw new AppError("bad_request", `The display label can be shown to customers, so it can't include the last name. Try "${p.firstName} ${p.lastName[0]}."`);
  const dup = await db.query.staff.findFirst({ where: and(sql`lower(${staff.displayLabel}) = lower(${p.displayLabel})`, eq(staff.active, true), ne(staff.id, staffId)), columns: { id: true } });
  if (dup) throw new AppError("conflict", `"${p.displayLabel}" is already used by someone else. Add an initial.`);
  const changed = {
    ...(row.firstName !== p.firstName ? { firstName: { from: row.firstName, to: p.firstName } } : {}),
    ...((row.lastName ?? "") !== p.lastName ? { lastName: "changed" } : {}),
    ...(row.displayLabel !== p.displayLabel ? { displayLabel: { from: row.displayLabel, to: p.displayLabel } } : {}),
    ...(email !== row.email ? { email: "changed" } : {}),
  };
  if (!Object.keys(changed).length) return null;
  await db.transaction(async (tx) => {
    await tx
      .update(staff)
      .set({ firstName: p.firstName, lastName: p.lastName || null, displayLabel: p.displayLabel, email, ...(email !== row.email && row.passwordHash ? { sessionsValidAfter: new Date() } : {}) })
      .where(eq(staff.id, staffId));
    await audit(ctx.actor, "user.update", "staff", staffId, changed, null, tx);
  });
  return null;
}
