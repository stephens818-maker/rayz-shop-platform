/**
 * Brand portal user admin, end to end: an emailed invite with a one-time link, sign-up with a
 * password and an authenticator, two-step sign-in, the remote access toggle, deactivating and
 * removing. Nobody locks out the brand (a Brand Owner who can sign in always remains), acts on
 * someone above them, gives what they don't have, or turns off their own safeguards.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Mods, loadModules } from "./setup";
import { open as openPage } from "./render";
import { jar, redirectTarget, signInAs } from "./session";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));

let m: Mods;
const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);

const LOGINS = ["owner", "admin", "michelle", "makenna", "frontdesk", "regional", "coralville"] as const;
type Login = (typeof LOGINS)[number];
const people = {} as Record<Login, string>;
const ids = {} as { coralville: string; moline: string; regionalRole: string; frontDeskRole: string; ownerRole: string; ritaToken?: string };
const as = (l: Login) => signInAs(people[l]);
const actions = () => import("@/app/admin/users/actions");
const ctx = async () => (await import("@/server/auth/staff")).getStaffContext();
const row = (id: string) => m.db.db.query.staff.findFirst({ where: eq(m.schema.staff.id, id) }).then((r) => r!);
const audits = async (action: string, entityId?: string) =>
  (await m.db.db.select().from(m.schema.auditLog).where(eq(m.schema.auditLog.action, action))).filter((a) => !entityId || a.entityId === entityId);

const RITA = { firstName: "Rita", lastName: "Ramos", displayLabel: "Rita R.", email: "rita.ramos@example.test" };
const PASSWORD = "Barber-pole-2026";
let rita = "";
let ritaSecret = "";

async function signIn(fields: Record<string, string>) {
  const { login } = await import("@/app/login/actions");
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  try {
    return { state: await login(null, f), redirect: null as string | null };
  } catch (e) {
    const to = redirectTarget(e);
    if (to) return { state: null, redirect: to };
    throw e;
  }
}

async function inviteRita(over: Record<string, unknown> = {}) {
  const r = await (await actions()).inviteUserAction({ ...RITA, roleId: ids.regionalRole, scope: "selected", shopIds: [ids.moline], twoFactorRequired: true, remote: true, ...over });
  return r;
}

beforeAll(async () => {
  m = await loadModules();
  for (const l of LOGINS) people[l] = (await m.db.db.query.staff.findFirst({ where: eq(m.schema.staff.email, `${l}@rayz.test`) }))!.id;
  ids.coralville = (await m.db.db.query.shops.findFirst({ where: eq(m.schema.shops.slug, "coralville") }))!.id;
  ids.moline = (await m.db.db.query.shops.findFirst({ where: eq(m.schema.shops.slug, "moline") }))!.id;
  const role = async (key: string) => (await m.db.db.query.roles.findFirst({ where: eq(m.schema.roles.key, key) }))!.id;
  ids.regionalRole = await role("regional_manager");
  ids.frontDeskRole = await role("front_desk");
  ids.ownerRole = await role("brand_owner");
  // Michelle may manage users at her shop, but holds less than a regional manager and no remote access.
  await m.db.db.update(m.schema.staff).set({ permissionOverrides: { "permissions.manage": true, "access.remote": false } }).where(eq(m.schema.staff.id, people.michelle));
}, 180_000);

afterAll(async () => {
  await m?.db.closeDb();
});

describe("inviting", () => {
  it("adds the user with their role and locations, and the email keeps no link", async () => {
    await as("owner");
    const r = await inviteRita();
    expect(r).toMatchObject({ ok: true, data: { delivered: false, link: expect.stringMatching(/\/invite\/[A-Za-z0-9_-]{40,}$/) } });
    if (!r.ok) return;
    rita = r.data.staffId;
    const s = await row(rita);
    expect(s).toMatchObject({ roleId: ids.regionalRole, shopScope: "one", twoFactorRequired: true, passwordHash: null, isBookable: false, active: true });
    expect(s.invitedAt).toBeInstanceOf(Date);
    const { loadStaffAccess } = await import("@/server/auth/access");
    const a = (await loadStaffAccess(rita))!;
    expect(a.shopIds).toEqual([ids.moline]);
    expect(a.permissions.has("access.remote")).toBe(true);
    const token = r.data.link!.split("/invite/")[1];
    const [invite] = await m.db.db.select().from(m.schema.staffInvites).where(eq(m.schema.staffInvites.staffId, rita));
    expect(invite.tokenHash).not.toContain(token);
    expect(invite.expiresAt.getTime() - Date.now()).toBeGreaterThan(6.9 * 86_400_000);
    const [job] = await m.db.db.select().from(m.schema.notificationJobs).where(eq(m.schema.notificationJobs.kind, "staff_invite"));
    expect(job.to).toBe(RITA.email);
    expect(job.body).toContain("[sign-up link removed]");
    expect(job.body).not.toContain(token);
    const [log] = await audits("user.invite", rita);
    expect(log).toMatchObject({ actorStaffId: people.owner, details: { role: "Regional Manager", twoFactorRequired: true, remoteAccess: true } });
    expect(JSON.stringify(log.details)).not.toContain(token);
    ids.ritaToken = token;
  });

  it("refuses a used email, and anything the inviter couldn't give", async () => {
    await as("owner");
    expect(await inviteRita({ displayLabel: "Rita 2" })).toMatchObject({ ok: false, error: expect.stringMatching(/already signs in with that email/) });
    await as("admin");
    expect(await inviteRita({ email: "own@example.test", displayLabel: "Own", roleId: ids.ownerRole, scope: "all" })).toMatchObject({ ok: false, error: expect.stringMatching(/Only the Brand Owner can grant Brand Owner/) });
    await as("michelle");
    const base = { firstName: "Pat", lastName: "", displayLabel: "Pat", email: "pat@example.test", twoFactorRequired: false, remote: false };
    const invite = async (o: Record<string, unknown>) => (await actions()).inviteUserAction({ ...base, roleId: ids.frontDeskRole, scope: "selected", shopIds: [ids.coralville], ...o } as never);
    expect(await invite({ roleId: ids.regionalRole })).toMatchObject({ ok: false, error: expect.stringMatching(/you don't have/) });
    expect(await invite({ scope: "all", shopIds: [] })).toMatchObject({ ok: false });
    expect(await invite({ shopIds: [ids.moline] })).toMatchObject({ ok: false, error: expect.stringMatching(/your own shops/) });
    expect(await invite({ remote: true })).toMatchObject({ ok: false, error: expect.stringMatching(/Can access remotely/) });
    const ok = await invite({});
    expect(ok).toMatchObject({ ok: true });
    await as("frontdesk");
    expect(await invite({ email: "pat2@example.test", displayLabel: "Pat 2" })).toMatchObject({ ok: false, error: expect.stringMatching(/can't manage users/) });
  });
});

describe("signing up and two-step sign-in", () => {
  it("the link sets a password and an authenticator, once", async () => {
    const { openInvite, inviteEnrollment, acceptInvite } = await import("@/server/users");
    const { open } = await import("@/lib/secret-box");
    const { totpCode } = await import("@/lib/totp");
    const token = ids.ritaToken!;
    expect(await openInvite("x".repeat(43))).toBeNull();
    const found = (await openInvite(token))!;
    expect(found.person.id).toBe(rita);
    const e = await inviteEnrollment(found.invite.id, RITA.email);
    ritaSecret = (JSON.parse(open(e.sealed)!) as { s: string }).s;
    await expect(acceptInvite({ token, password: "short", sealed: e.sealed, code: totpCode(ritaSecret) })).rejects.toThrow(/at least 10/);
    await expect(acceptInvite({ token, password: PASSWORD, sealed: e.sealed, code: "000000" === totpCode(ritaSecret) ? "111111" : "000000" })).rejects.toThrow(/didn't work/);
    const other = await inviteEnrollment("00000000-0000-0000-0000-000000000000", RITA.email);
    await expect(acceptInvite({ token, password: PASSWORD, sealed: other.sealed, code: "123456" })).rejects.toThrow(/Reload/);
    expect(await acceptInvite({ token, password: PASSWORD, sealed: e.sealed, code: totpCode(ritaSecret) })).toEqual({ email: RITA.email });
    const s = await row(rita);
    expect(s.passwordHash).toBeTruthy();
    expect(s.totpEnabledAt).toBeInstanceOf(Date);
    expect(s.totpSecret).not.toContain(ritaSecret);
    expect(await openInvite(token)).toBeNull();
    await expect(acceptInvite({ token, password: PASSWORD, sealed: e.sealed, code: totpCode(ritaSecret) })).rejects.toThrow(/expired or was already used/);
    expect(await audits("user.signup", rita)).toHaveLength(1);
    const page = await import("@/app/invite/[token]/page");
    const { textOf } = await import("./render");
    expect(await textOf(await page.default({ params: Promise.resolve({ token }) }), new Set())).toMatch(/doesn't work/);
  });

  it("a password alone isn't enough; a code works once; wrong codes pause sign-in", async () => {
    const { totpCode } = await import("@/lib/totp");
    jar.ip = "203.0.113.7";
    const first = await signIn({ email: RITA.email, password: PASSWORD });
    expect(first.redirect).toBeNull();
    expect(first.state?.twoFactor?.ticket).toBeTruthy();
    expect(first.state?.twoFactor?.enroll).toBeUndefined();
    const ticket = first.state!.twoFactor!.ticket;
    const code = totpCode(ritaSecret, Date.now() + 30_000);
    expect((await signIn({ ticket, code: code === "000000" ? "111111" : "000000" })).state?.error).toMatch(/didn't work/);
    expect((await signIn({ ticket, code })).redirect).toMatch(/^\/admin/);
    expect((await signIn({ ticket, code })).state?.error).toMatch(/didn't work/);
    expect((await audits("staff.login", rita)).at(-1)?.details).toMatchObject({ twoStep: true });
    expect((await signIn({ ticket: "forged", code })).state?.error).toMatch(/Sign in again/);

    for (let i = 0; i < 4; i++) await signIn({ ticket, code: "999999" === totpCode(ritaSecret) ? "888888" : "999999" });
    expect((await signIn({ ticket, code: totpCode(ritaSecret, Date.now() + 30_000) })).state?.error).toMatch(/Too many wrong codes/);
    expect((await row(rita)).totpLockedUntil!.getTime()).toBeGreaterThan(Date.now());
    await m.db.db.update(m.schema.staff).set({ totpLockedUntil: null, totpFailures: 0 }).where(eq(m.schema.staff.id, rita));
  });

  it("requiring it for someone signs them out and sets it up at their next sign-in", async () => {
    const { totpCode } = await import("@/lib/totp");
    await as("owner");
    expect(await (await actions()).setTwoFactorRequiredAction(people.frontdesk, true)).toMatchObject({ ok: true });
    const fd = await row(people.frontdesk);
    expect(fd.twoFactorRequired).toBe(true);
    expect(fd.sessionsValidAfter).toBeInstanceOf(Date);
    const first = await signIn({ email: "frontdesk@rayz.test", password: process.env.SEED_PASSWORD ?? "rayz2026!" });
    const enroll = first.state?.twoFactor?.enroll;
    expect(enroll?.qr).toMatch(/^data:image\/png;base64,/);
    const secret = enroll!.secret.replace(/\s/g, "");
    expect((await signIn({ ticket: first.state!.twoFactor!.ticket, code: totpCode(secret) })).redirect).toMatch(/^\/admin/);
    expect((await row(people.frontdesk)).totpEnabledAt).toBeInstanceOf(Date);
    expect(await audits("user.two_factor", people.frontdesk)).toHaveLength(1);
    expect(await audits("user.two_factor_setup", people.frontdesk)).toHaveLength(1);

    // A lost phone: an admin resets it, and the next sign-in sets up a new one.
    expect(await (await actions()).resetTwoFactorAction(people.frontdesk)).toMatchObject({ ok: true });
    expect((await row(people.frontdesk)).totpSecret).toBeNull();
    expect((await signIn({ email: "frontdesk@rayz.test", password: process.env.SEED_PASSWORD ?? "rayz2026!" })).state?.twoFactor?.enroll).toBeTruthy();
    await m.db.db.update(m.schema.staff).set({ twoFactorRequired: false }).where(eq(m.schema.staff.id, people.frontdesk));
  });
});

describe("remote access", () => {
  it("is a per-user toggle, given only by people who have it, never to yourself", async () => {
    const { setRemoteAccessAction } = await actions();
    const { loadStaffAccess } = await import("@/server/auth/access");
    await as("michelle");
    expect(await setRemoteAccessAction(people.makenna, true)).toMatchObject({ ok: false, error: expect.stringMatching(/Can access remotely/) });
    await as("admin");
    expect(await setRemoteAccessAction(people.makenna, true)).toMatchObject({ ok: true });
    expect((await loadStaffAccess(people.makenna))!.permissions.has("access.remote")).toBe(true);
    expect(await setRemoteAccessAction(people.admin, false)).toMatchObject({ ok: false, error: expect.stringMatching(/your own access/) });
    expect(await setRemoteAccessAction(people.makenna, false)).toMatchObject({ ok: true });
    expect((await loadStaffAccess(people.makenna))!.permissions.has("access.remote")).toBe(false);
    expect((await audits("user.remote_access", people.makenna)).map((a) => (a.details as { remoteAccess: boolean }).remoteAccess)).toEqual([true, false]);
  });
});

describe("deactivating and removing", () => {
  it("deactivating signs them out and stops sign-in; reactivating brings them back", async () => {
    const { setUserActiveAction } = await actions();
    await signInAs(rita);
    expect(await ctx()).not.toBeNull();
    await as("owner");
    expect(await setUserActiveAction(rita, false)).toMatchObject({ ok: true });
    await signInAs(rita);
    expect(await ctx()).toBeNull();
    expect((await signIn({ email: RITA.email, password: PASSWORD })).state?.error).toMatch(/incorrect/);
    await as("owner");
    expect(await setUserActiveAction(rita, false)).toMatchObject({ ok: false, error: expect.stringMatching(/already/) });
    expect(await setUserActiveAction(rita, true)).toMatchObject({ ok: true });
    expect((await signIn({ email: RITA.email, password: PASSWORD })).state?.twoFactor).toBeTruthy();
    expect((await audits("user.deactivate", rita)).length + (await audits("user.reactivate", rita)).length).toBe(2);
  });

  it("there's always a Brand Owner who can sign in, and nobody acts on someone above them", async () => {
    const { setUserActiveAction, removeUserAction, setTwoFactorRequiredAction } = await actions();
    await as("owner");
    expect(await setUserActiveAction(people.owner, false)).toMatchObject({ ok: false, error: expect.stringMatching(/yourself/) });
    expect(await removeUserAction(people.owner, "Owner")).toMatchObject({ ok: false, error: expect.stringMatching(/yourself/) });
    expect(await setTwoFactorRequiredAction(people.owner, true)).toMatchObject({ ok: true });
    expect(await setTwoFactorRequiredAction(people.owner, false)).toMatchObject({ ok: false, error: expect.stringMatching(/yourself/) });
    await m.db.db.update(m.schema.staff).set({ twoFactorRequired: false }).where(eq(m.schema.staff.id, people.owner));
    await as("admin");
    for (const r of [await setUserActiveAction(people.owner, false), await removeUserAction(people.owner, "Owner"), await setTwoFactorRequiredAction(people.owner, true)])
      expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/Brand Owner/) });
    await as("michelle");
    expect(await setUserActiveAction(people.regional, false)).toMatchObject({ ok: false });
    expect(await setUserActiveAction(people.admin, false)).toMatchObject({ ok: false });

    // A second owner, invited but never signed up, doesn't count: the only one who can sign in stays.
    await as("owner");
    const second = await (await actions()).inviteUserAction({ firstName: "Sam", lastName: "", displayLabel: "Sam (co-owner)", email: "sam@example.test", roleId: ids.ownerRole, scope: "all", shopIds: [], twoFactorRequired: false, remote: false });
    expect(second).toMatchObject({ ok: true });
    const { activeOwnerCount } = await import("@/server/auth/access");
    expect(await activeOwnerCount()).toBe(1);
    const { saveUserAccessAction } = await import("@/app/admin/permissions/actions");
    if (second.ok) {
      await signInAs(second.data.staffId);
      expect(await saveUserAccessAction({ staffId: people.owner, roleId: ids.regionalRole, overrides: {}, maxDiscountPct: null, scope: "selected", shopIds: [ids.moline] })).toMatchObject({ ok: false });
    }
  });

  it("removing keeps their history but they never sign in again, and their contact access ends", async () => {
    const { removeUserAction, setUserActiveAction } = await actions();
    await as("owner");
    await m.db.db.insert(m.schema.clientContactGrants).values({ kind: "full_contact", staffId: rita, grantedBy: people.owner, grantedByLabel: "Brand Owner:Owner" });
    expect(await removeUserAction(rita, "wrong name")).toMatchObject({ ok: false, error: expect.stringMatching(/to confirm/) });
    await as("michelle");
    expect(await removeUserAction(rita, RITA.displayLabel)).toMatchObject({ ok: false });
    await as("owner");
    expect(await removeUserAction(rita, RITA.displayLabel)).toMatchObject({ ok: true });
    const s = await row(rita);
    expect(s).toMatchObject({ active: false, email: null, passwordHash: null, totpSecret: null });
    expect(s.removedAt).toBeInstanceOf(Date);
    expect((await signIn({ email: RITA.email, password: PASSWORD })).state?.error).toMatch(/incorrect/);
    const grants = await m.db.db.select().from(m.schema.clientContactGrants).where(eq(m.schema.clientContactGrants.staffId, rita));
    expect(grants.every((g) => g.revokedAt)).toBe(true);
    expect(await setUserActiveAction(rita, true)).toMatchObject({ ok: false, error: expect.stringMatching(/removed/) });
    expect((await audits("user.remove", rita))[0].details).toMatchObject({ contactGrantsRevoked: 1 });
    const { listUsers } = await import("@/server/users");
    expect((await listUsers((await ctx())!)).map((u) => u.id)).not.toContain(rita);
    expect(await audits("user.invite", rita)).toHaveLength(1);
  });

  it("people with upcoming appointments are offboarded first", async () => {
    const { setUserActiveAction } = await actions();
    // Just after midnight in Iowa, clear of the seeded appointments whatever time the test runs.
    const day = new Date(Date.now() + 3 * 86_400_000);
    const at = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 6, 5));
    const [c] = await m.db.db.insert(m.schema.customers).values({ firstName: "Booked", lastName: "Client", homeShopId: ids.coralville }).returning();
    await m.db.db.insert(m.schema.appointments).values({ code: `U${crypto.randomUUID().slice(0, 7).toUpperCase()}`, shopId: ids.coralville, staffId: people.makenna, customerId: c.id, startsAt: at, endsAt: new Date(at.getTime() + 30 * 60_000), status: "booked", source: "staff", estimateCents: 2300 });
    await as("owner");
    expect(await setUserActiveAction(people.makenna, false)).toMatchObject({ ok: false, error: expect.stringMatching(/upcoming appointment/) });
  });
});

describe("pages", () => {
  it("brand admins manage users; people without user management can't open them", async () => {
    await as("admin");
    const list = await openPage("/admin/users");
    expect(list.kind).toBe("ok");
    expect(list.text).toContain("Invite a user");
    expect(list.text).toContain("Michelle");
    expect(list.text).toContain("Role templates");
    const one = await openPage("/admin/users/[id]", { id: people.michelle });
    expect(one.kind).toBe("ok");
    expect(one.text).toContain("Sign-in");
    expect(one.text).toContain("Role, permissions and locations");
    expect((await openPage("/admin/users/[id]", { id: people.coralville })).kind).toBe("404");
    await as("frontdesk");
    expect((await openPage("/admin/users")).kind).toBe("denied");
    await as("michelle");
    expect((await openPage("/admin/users/[id]", { id: people.regional })).kind).toBe("404");
  });
});
