import "server-only";
import { and, asc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { brandSettings, clientAccessAlerts, clientAccessLog, clientFieldRules, clientFields, notificationJobs, roles, staff } from "@/db/schema";
import {
  ACCESS_KINDS,
  AccessKind,
  BUILTIN_FIELDS,
  EntrySetting,
  FieldEntry,
  FieldKey,
  FieldRule,
  Level,
  LookupLimits,
  ShopLoginCap,
  ShownField,
  cleanLimits,
  cleanShopLoginCap,
  customFieldKey,
  isShopLoginCap,
  shopLoginLevel,
  entryDenied,
  fieldLabel,
  formatBirthday,
  maskValue,
  minLevel,
  resolveEntry,
  resolveLevel,
  validRule,
} from "@/domain/client-privacy";
import { OWNER_ROLE_KEY } from "@/domain/permissions";
import type { RatingSummary } from "@/domain/ratings";
import { appBaseUrl } from "@/lib/deployment";
import { formatPhone } from "@/lib/phone";
import { Actor, audit } from "./audit";
import type { StaffContext } from "./auth/staff";
import { AppError } from "./errors";

/**
 * What one signed-in person may see of client records, worked out once per request from the
 * brand portal's rules. Everything that renders or returns client data goes through `show`, so a
 * hidden value is never read into a page, an action result, an export or an API response.
 */
export interface ClientPolicy {
  staffId: string;
  isOwner: boolean;
  /** clients.reveal: masked fields can be revealed, one at a time, with a reason. */
  canReveal: boolean;
  /** Active custom fields, in order. */
  custom: { id: string; label: string }[];
  level(f: FieldKey): Level;
  /** Fill in the field where it's empty: a new client, a booking, a walk-in, checkout. */
  canAdd(f: FieldKey): boolean;
  /** Replace or clear what's on file, seen or not. */
  canEdit(f: FieldKey): boolean;
  entry(f: FieldKey): FieldEntry;
  /** The value as this person may see it: the full value (formatted), the masked form, or null. */
  show(f: FieldKey, raw: string | null | undefined): string | null;
  /** A client's star average: dropped when ratings are hidden. */
  stars<R extends RatingSummary>(r: R | null | undefined): R | null;
  /** Individual ratings and notes, not just the average. */
  ratingDetail: boolean;
}

type Working = { shopId: string | null; roleId: string; roleKey: string | null };

/** Whose role applies where: the shop they're in, every shop they're working across, or brand-wide. */
function workingAs(ctx: StaffContext): Working[] {
  const main = ctx.access.role;
  if (ctx.currentShopId) return [{ shopId: ctx.currentShopId, roleId: ctx.staff.roleId, roleKey: ctx.staff.roleKey }];
  if (ctx.brandWide || !ctx.shopIds.length) return [{ shopId: null, roleId: main.id, roleKey: main.key }];
  return ctx.shopIds.map((s) => {
    const r = ctx.access.byShop.get(s)?.role ?? main;
    return { shopId: s, roleId: r.id, roleKey: r.key };
  });
}

export async function activeCustomFields() {
  return db
    .select({ id: clientFields.id, label: clientFields.label })
    .from(clientFields)
    .where(eq(clientFields.active, true))
    .orderBy(asc(clientFields.sortOrder), asc(clientFields.label));
}

export async function rulesFor(staffId: string, roleIds: string[]): Promise<FieldRule[]> {
  const rows = await db
    .select()
    .from(clientFieldRules)
    .where(or(eq(clientFieldRules.staffId, staffId), roleIds.length ? and(inArray(clientFieldRules.roleId, roleIds), isNull(clientFieldRules.staffId)) : undefined));
  return rows.filter(validRule);
}

/** Combined across the shops someone works in at once, the strictest level wins. */
export function levelsFor(rules: readonly FieldRule[], staffId: string, working: readonly Working[], fields: readonly FieldKey[]): Map<FieldKey, Level> {
  return new Map(fields.map((f) => [f, minLevel(...working.map((w) => resolveLevel(rules, { staffId, roleId: w.roleId, roleKey: w.roleKey }, w.shopId, f)))]));
}

/** Entry rights keyed `add:<field>` and `edit:<field>`; across several shops at once, every one must allow it. */
export function entriesFor(rules: readonly FieldRule[], staffId: string, working: readonly Working[], fields: readonly FieldKey[]): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const f of fields)
    for (const s of ["add", "edit"] as EntrySetting[])
      out.set(
        `${s}:${f}`,
        working.every((w) => resolveEntry(rules, { staffId, roleId: w.roleId, roleKey: w.roleKey }, w.shopId, f, s)),
      );
  return out;
}

const FULL_DISPLAY: Partial<Record<FieldKey, (v: string) => string>> = { phone: (v) => formatPhone(v) || v, birthday: (v) => formatBirthday(v) ?? v };

export function displayFull(f: FieldKey, raw: string | null | undefined): string | null {
  if (raw == null || raw === "") return null;
  return FULL_DISPLAY[f]?.(raw) ?? raw;
}

export function makePolicy(o: {
  staffId: string;
  isOwner: boolean;
  canReveal: boolean;
  custom: { id: string; label: string }[];
  levels: Map<FieldKey, Level>;
  entries?: Map<string, boolean>;
}): ClientPolicy {
  const level = (f: FieldKey): Level => (o.isOwner ? "full" : (o.levels.get(f) ?? "hidden"));
  const may = (s: EntrySetting, f: FieldKey) => f !== "ratings" && (o.isOwner || (o.entries?.get(`${s}:${f}`) ?? false));
  const canAdd = (f: FieldKey) => may("add", f);
  const canEdit = (f: FieldKey) => may("edit", f);
  return {
    staffId: o.staffId,
    isOwner: o.isOwner,
    canReveal: o.canReveal,
    custom: o.custom,
    level,
    canAdd,
    canEdit,
    entry: (f) => ({ level: level(f), canAdd: canAdd(f), canEdit: canEdit(f) }),
    show(f, raw) {
      const l = level(f);
      if (l === "hidden") return null;
      return l === "full" ? displayFull(f, raw) : maskValue(f, raw);
    },
    stars: (r) => (level("ratings") === "hidden" ? null : (r ?? null)),
    ratingDetail: level("ratings") === "full",
  };
}

/** Sees no client details: for code paths that weren't handed the viewer's policy. */
export const LOCKED_POLICY: ClientPolicy = makePolicy({ staffId: "", isOwner: false, canReveal: false, custom: [], levels: new Map() });

const policies = new WeakMap<StaffContext, Promise<ClientPolicy>>();

export function clientPolicy(ctx: StaffContext): Promise<ClientPolicy> {
  let p = policies.get(ctx);
  if (!p) {
    p = (async () => {
      const custom = await activeCustomFields();
      const fields: FieldKey[] = [...BUILTIN_FIELDS.map((f) => f.key), ...custom.map((c) => customFieldKey(c.id))];
      const working = workingAs(ctx);
      const rules = ctx.isOwner ? [] : await rulesFor(ctx.staff.id, [...new Set(working.map((w) => w.roleId))]);
      let levels = levelsFor(rules, ctx.staff.id, working, fields);
      if (ctx.staff.kind === "shop") {
        const cap = await shopLoginCap();
        levels = new Map([...levels].map(([f, l]) => [f, shopLoginLevel(cap, f, l)]));
      }
      return makePolicy({
        staffId: ctx.staff.id,
        isOwner: ctx.isOwner,
        canReveal: ctx.permissions.has("clients.reveal"),
        custom,
        levels,
        entries: entriesFor(rules, ctx.staff.id, working, fields),
      });
    })();
    policies.set(ctx, p);
  }
  return p;
}

/** Search by part of a phone or email only for people who see it in full; see SearchReach. */
export const searchReach = (p: ClientPolicy) => ({ phone: p.level("phone") === "full", email: p.level("email") === "full" });

/** One client's fields as a person may see them. Nothing else from the record should be rendered. */
export interface ShownClient {
  id: string;
  firstName: string;
  lastName: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  birthday: string | null;
  notes: string | null;
  preferredBarber: string | null;
  custom: { id: string; label: string; value: string; level: Level }[];
  levels: Record<(typeof BUILTIN_FIELDS)[number]["key"], Level>;
  /** Whether there's a phone or email on file, without saying what it is. */
  hasPhone: boolean;
  hasEmail: boolean;
}

export function showClient(
  p: ClientPolicy,
  c: {
    id: string;
    firstName: string;
    lastName: string | null;
    phone?: string | null;
    email?: string | null;
    address?: string | null;
    birthday?: string | null;
    notes?: string | null;
    customFields?: Record<string, string> | null;
  },
  preferredBarberLabel: string | null = null,
): ShownClient {
  return {
    id: c.id,
    firstName: c.firstName,
    lastName: c.lastName,
    phone: p.show("phone", c.phone),
    email: p.show("email", c.email),
    address: p.show("address", c.address),
    birthday: p.show("birthday", c.birthday),
    notes: p.show("notes", c.notes),
    preferredBarber: p.show("preferred_barber", preferredBarberLabel),
    custom: p.custom.flatMap((f) => {
      const key = customFieldKey(f.id);
      const value = p.show(key, c.customFields?.[f.id]);
      return value ? [{ id: f.id, label: f.label, value, level: p.level(key) }] : [];
    }),
    levels: Object.fromEntries(BUILTIN_FIELDS.map((f) => [f.key, p.level(f.key)])) as ShownClient["levels"],
    hasPhone: !!c.phone,
    hasEmail: !!c.email,
  };
}

// ───────────────────────────── Entering details ─────────────────────────────

/** One field for a form or an action's result: as the person may see it, whether something is on file, and what they may enter. */
export function shownField(p: ClientPolicy, f: FieldKey, raw: string | null | undefined, label = fieldLabel(f, p.custom)): ShownField {
  return { key: f, label, level: p.level(f), value: p.show(f, raw), saved: raw != null && raw !== "", canAdd: p.canAdd(f), canEdit: p.canEdit(f) };
}

/**
 * The value a form leaves in a field (`next` undefined: left alone). Refuses what the person may
 * not enter; see entryDenied. The old value is never part of the answer.
 */
export function entered(p: ClientPolicy, f: FieldKey, before: string | null | undefined, next: string | null | undefined): string | null {
  const denied = entryDenied(p.entry(f), before, next);
  const label = fieldLabel(f, p.custom)
    .toLowerCase()
    .replace(/^client /, "");
  if (denied === "add") throw new AppError("forbidden", `You can't add a client's ${label}`);
  if (denied === "edit") throw new AppError("forbidden", `You can't change a client's ${label} once it's on file`);
  return next === undefined ? (before ?? null) : next || null;
}

/** Contact details typed into a booking, walk-in or checkout: each one given needs "add". */
export function assertCanEnter(p: ClientPolicy, given: Partial<Record<"phone" | "email", string | null | undefined>>) {
  for (const f of ["phone", "email"] as const) if (given[f]?.trim()) entered(p, f, null, given[f]);
}

// ───────────────────────────── Audit details ─────────────────────────────

const CLIENT_KEYS: Partial<Record<string, FieldKey>> = { phone: "phone", email: "email", address: "address", birthday: "birthday", notes: "notes" };

/**
 * Client values recorded in the audit log (an edit's before and after, a merged record) shown as
 * the reader may see them, so the log can't be used to read what the profile masks.
 */
export function redactAuditDetails(p: ClientPolicy, entity: string, details: unknown): unknown {
  if (p.isOwner || !details || typeof details !== "object") return details;
  if (entity === "client_rating") {
    if (p.ratingDetail) return details;
    const d = { ...(details as Record<string, unknown>) };
    if ("note" in d) d.note = "(hidden)";
    if ("stars" in d && !p.stars({ avg: 0, count: 0 })) d.stars = "(hidden)";
    return d;
  }
  if (entity !== "customer") return details;
  const walk = (v: unknown, field?: FieldKey): unknown => {
    if (field) {
      if (typeof v === "string") return p.show(field, v) ?? "(hidden)";
      if (v && typeof v === "object" && !Array.isArray(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, field)]));
      return v;
    }
    if (Array.isArray(v)) return v.map((x) => walk(x));
    if (!v || typeof v !== "object") return v;
    return Object.fromEntries(
      Object.entries(v).map(([k, x]) => {
        if (k === "customFields") return [k, typeof x === "object" && x ? Object.fromEntries(Object.entries(x).map(([id, y]) => [id, walk(y, customFieldKey(id))])) : x];
        const f = CLIENT_KEYS[k];
        return [k, f ? walk(x, f) : walk(x)];
      }),
    );
  };
  return walk(details);
}

const IMPORT_COLUMNS: Partial<Record<string, FieldKey>> = { phone: "phone", email: "email", notes: "notes", preferredBarber: "preferred_barber" };

/**
 * Skipped import rows carry the original CSV row so it can be fixed and re-imported; client details
 * in it show as the reader may see them. `headerMap` is the importer's field → column mapping.
 */
export function redactImportErrors<E extends { data?: Record<string, string> }>(p: ClientPolicy, headerMap: Record<string, string>, errors: E[]): E[] {
  if (p.isOwner) return errors;
  const columns = Object.entries(headerMap).flatMap(([field, col]) =>
    IMPORT_COLUMNS[field] && p.level(IMPORT_COLUMNS[field]) !== "full" ? [[col, IMPORT_COLUMNS[field]] as const] : [],
  );
  if (!columns.length) return errors;
  return errors.map((e) =>
    e.data ? { ...e, data: { ...e.data, ...Object.fromEntries(columns.filter(([c]) => c in e.data!).map(([c, f]) => [c, p.show(f, e.data![c]) ?? ""])) } } : e,
  );
}

/** Whether the audit log search may look inside client entries (it would confirm a number the reader can't see). */
export const searchesClientDetails = (p: ClientPolicy) => p.isOwner || (["phone", "email", "address", "birthday", "notes"] as const).every((f) => p.level(f) === "full");

// ───────────────────────────── Access log, limits and alerts ─────────────────────────────

/** How much of a client's contact details shop logins see: masked at most unless the brand says otherwise. */
export async function shopLoginCap(): Promise<ShopLoginCap> {
  const [row] = await db.select({ r: brandSettings.shopLogin }).from(brandSettings).where(eq(brandSettings.id, 1));
  return cleanShopLoginCap(row?.r?.clientContact);
}

export async function saveShopLoginCap(cap: ShopLoginCap, actor: Actor) {
  if (!isShopLoginCap(cap)) throw new AppError("bad_request", "Pick how much shop logins see");
  const before = await shopLoginCap();
  await db
    .update(brandSettings)
    .set({ shopLogin: sql`${brandSettings.shopLogin} || ${JSON.stringify({ clientContact: cap })}::jsonb`, updatedAt: new Date() })
    .where(eq(brandSettings.id, 1));
  await audit(actor, "client_privacy.shop_login_cap", "brand_settings", "1", { before, after: cap });
}

export async function lookupLimits(): Promise<LookupLimits> {
  const [row] = await db.select({ l: brandSettings.clientLookupLimits }).from(brandSettings).where(eq(brandSettings.id, 1));
  return cleanLimits(row?.l);
}

const PROFILE_KINDS: AccessKind[] = ["view", "reveal"];
const SEARCH_KINDS: AccessKind[] = ["search", "list"];

export const isPaused = (e: unknown) => e instanceof AppError && e.code === "rate_limited";

export const PAUSED_MESSAGE = "You've looked up a lot of clients in a short time, so client lookups are paused for a few minutes. A brand admin has been notified.";

/** People who get unusual-lookup alerts: the Brand Owner and anyone across all shops whose role manages client data. */
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
        or(eq(roles.key, OWNER_ROLE_KEY), and(eq(staff.shopScope, "all"), sql`${roles.permissions} ? 'clients.privacy'`)),
      ),
    );
}

async function raiseAlert(ctx: StaffContext, kind: "unusual" | "paused", counts: { profiles: number; searches: number }, limits: LookupLimits, since: Date) {
  const [open] = await db
    .select({ id: clientAccessAlerts.id })
    .from(clientAccessAlerts)
    .where(and(eq(clientAccessAlerts.staffId, ctx.staff.id), eq(clientAccessAlerts.kind, kind), gt(clientAccessAlerts.at, since)))
    .limit(1);
  if (open) return;
  await db
    .insert(clientAccessAlerts)
    .values({ staffId: ctx.staff.id, actorLabel: ctx.actor.label, kind, profiles: counts.profiles, searches: counts.searches, windowMinutes: limits.windowMinutes });
  const who = ctx.staff.displayLabel;
  const what = `${counts.profiles} client profile${counts.profiles === 1 ? "" : "s"} and ${counts.searches} search${counts.searches === 1 ? "" : "es"} in ${limits.windowMinutes} minutes`;
  const body = `${kind === "paused" ? `Client lookups for ${who} were paused` : `Unusual client lookups by ${who}`}: ${what}. See who viewed what: ${appBaseUrl()}/admin/client-data/access`;
  const to = (await alertRecipients(ctx.staff.id)).map((r) => r.email!);
  if (to.length)
    await db
      .insert(notificationJobs)
      .values(
        to.map((email) => ({
          kind: "privacy_alert",
          channel: "email",
          to: email,
          subject: `Ray'z: ${kind === "paused" ? "client lookups paused" : "unusual client lookups"} (${who})`,
          body,
          runAt: new Date(),
        })),
      );
}

/**
 * Log a look at client data for the data-access report, and enforce the lookup limits: past the
 * alert level the brand admins are told once per window, past the limit lookups stop for everyone
 * but the Brand Owner. Searches and list pages count separately from profiles.
 */
export async function recordClientAccess(
  ctx: StaffContext,
  e: { kind: AccessKind; customerId?: string | null; field?: string | null; reason?: string | null; detail?: Record<string, unknown> },
) {
  const counted = PROFILE_KINDS.includes(e.kind) || SEARCH_KINDS.includes(e.kind);
  const row = {
    staffId: ctx.staff.id,
    actorLabel: ctx.actor.label,
    shopId: ctx.currentShopId,
    customerId: e.customerId ?? null,
    field: e.field ?? null,
    reason: e.reason ?? null,
    detail: e.detail ?? null,
  };
  if (!counted) {
    await db.insert(clientAccessLog).values({ ...row, kind: e.kind });
    return;
  }
  const limits = await lookupLimits();
  const since = new Date(Date.now() - limits.windowMinutes * 60_000);
  const [c] = (await db.execute(sql`
    select
      count(distinct customer_id) filter (where kind in ('view', 'reveal'))::int as profiles,
      count(*) filter (where kind in ('search', 'list'))::int as searches,
      bool_or(customer_id = ${e.customerId ?? null}::uuid and kind in ('view', 'reveal')) as seen
    from client_access_log where staff_id = ${ctx.staff.id} and at > ${since.toISOString()}
  `)) as unknown as { profiles: number; searches: number; seen: boolean | null }[];
  const profiles = c.profiles + (PROFILE_KINDS.includes(e.kind) && !c.seen ? 1 : 0);
  const searches = c.searches + (SEARCH_KINDS.includes(e.kind) ? 1 : 0);
  const counts = { profiles, searches };
  if (!ctx.isOwner && (profiles > limits.blockProfiles || searches > limits.blockSearches)) {
    await db.insert(clientAccessLog).values({ ...row, kind: "blocked", detail: { ...e.detail, wanted: e.kind, field: e.field ?? null } });
    await raiseAlert(ctx, "paused", counts, limits, since);
    throw new AppError("rate_limited", PAUSED_MESSAGE);
  }
  await db.insert(clientAccessLog).values({ ...row, kind: e.kind });
  if (!ctx.isOwner && (profiles >= limits.alertProfiles || searches >= limits.alertSearches)) await raiseAlert(ctx, "unusual", counts, limits, since);
}

export const accessLabel = (kind: string, field: string | null, fieldName: (f: string) => string) =>
  kind === "reveal" && field ? `Revealed ${fieldName(field).toLowerCase()}` : (ACCESS_KINDS[kind as AccessKind] ?? kind);
