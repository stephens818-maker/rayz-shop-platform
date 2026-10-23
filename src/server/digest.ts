import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { brandSettings, digestSends, notificationJobs, roles, shopClosures, shopHours, shops, staff, staffAccessShops } from "@/db/schema";
import { DigestSettings, DigestStaffShop, digestSettings, renderDigest } from "@/domain/digest";
import { appBaseUrl } from "@/lib/deployment";
import { addDays, endOfLocalDay, formatDate, minutesToLabel, todayLocal, weekdayOf, zonedWallTime } from "@/lib/time";
import { Actor, audit } from "./audit";
import { loadStaffAccess } from "./auth/access";
import { AppError } from "./errors";
import { processDueJobs } from "./notifications/queue";
import { staffingFor } from "./staff-time";
import { TodayViewer, salesPace, todayAlerts } from "./today";

/** Alerts that mean nothing at 7 AM. */
const NOT_IN_DIGEST = new Set(["sales_pace", "running_behind", "unread_texts"]);
const SEND_BY_MIN = 12 * 60;

export async function loadDigestSettings(): Promise<DigestSettings> {
  const [b] = await db.select({ d: brandSettings.digest }).from(brandSettings).limit(1);
  return digestSettings(b?.d);
}

export async function saveDigestSettings(raw: unknown, actor: Actor) {
  const parsed = DigestSettings.safeParse(raw);
  if (!parsed.success) throw new AppError("bad_request", parsed.error.issues[0]?.message ?? "Check the digest settings");
  await db.update(brandSettings).set({ digest: parsed.data });
  await audit(actor, "settings.digest", "brand_settings", "digest", parsed.data, null);
  return parsed.data;
}

export interface Recipient {
  staffId: string;
  email: string;
  label: string;
  role: string;
}

/** Active people with an email whose role (at any of their shops) is on the list, plus anyone added, minus anyone removed. */
export async function digestRecipients(s: DigestSettings): Promise<Recipient[]> {
  const people = await db
    .select({ id: staff.id, email: staff.email, label: staff.displayLabel, roleKey: roles.key, roleName: roles.name })
    .from(staff)
    .innerJoin(roles, eq(roles.id, staff.roleId))
    .where(and(eq(staff.active, true), eq(staff.kind, "person"), isNotNull(staff.email)));
  const shopRoles = await db
    .select({ staffId: staffAccessShops.staffId, key: roles.key })
    .from(staffAccessShops)
    .innerJoin(roles, eq(roles.id, staffAccessShops.roleId));
  return people
    .filter((p) => !s.exclude.includes(p.id) && (s.include.includes(p.id) || s.roles.includes(p.roleKey ?? "") || shopRoles.some((r) => r.staffId === p.id && s.roles.includes(r.key ?? ""))))
    .flatMap((p) => (p.email ? [{ staffId: p.id, email: p.email, label: p.label, role: p.roleName }] : []))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** One person's digest for the morning of `now`, or null when they have no open shops. */
export async function buildDigest(staffId: string, now: Date = new Date(), s?: DigestSettings) {
  const settings = s ?? (await loadDigestSettings());
  const access = await loadStaffAccess(staffId);
  const person = await db.query.staff.findFirst({ where: eq(staff.id, staffId), columns: { firstName: true, email: true } });
  if (!access || !person) return null;
  const open = access.shops.filter((x) => x.status !== "archived");
  if (!open.length) return null;
  const perms = access.permissions;
  const viewer: TodayViewer = { staffId, shopIds: open.map((x) => x.id), permissions: perms, brandWide: access.scope === "all", reasons: { staffId, seesPrivate: perms.has("blocks.private") } };
  const today = todayLocal(now);
  const yesterday = addDays(today, -1);
  const live = open.filter((x) => x.status === "live" || x.status === "closed").map((x) => x.id);

  const [pace, staffing, alerts] = await Promise.all([
    settings.sections.sales && perms.has("sales.view") ? salesPace(live, yesterday, endOfLocalDay(yesterday)) : Promise.resolve(null),
    settings.sections.staff && (perms.has("calendar.manage") || perms.has("schedules.edit") || perms.has("timeoff.approve")) ? staffingFor(live, today, today, viewer.reasons) : Promise.resolve(null),
    settings.sections.alerts ? todayAlerts(viewer, now).then((xs) => xs.filter((a) => !NOT_IN_DIGEST.has(a.type))) : Promise.resolve(null),
  ]);
  const staffShops: DigestStaffShop[] | null = staffing
    ? open
        .filter((x) => live.includes(x.id))
        .map((x) => {
          const rows = staffing.filter((r) => r.shopId === x.id);
          const timeOff = (r: (typeof rows)[number]) => r.blocks.filter((b) => b.category === "time_off");
          return {
            shop: x.name,
            working: rows.filter((r) => r.status === "working" || r.status === "partly_off").map((r) => r.label),
            off: rows
              .filter((r) => r.status === "off" || r.status === "partly_off")
              .map((r) => {
                const why = [...new Set(timeOff(r).map((b) => b.label.toLowerCase()))].join(", ");
                const when = r.status === "partly_off" ? timeOff(r).map((b) => ` ${minutesToLabel(b.startMin)}–${minutesToLabel(b.endMin % 1440)}`).join(",") : "";
                return `${r.label}${why ? ` (${why}${when})` : when ? ` (${when.trim()})` : ""}`;
              }),
            blocked: rows.flatMap((r) => {
              const held = r.blocks.filter((b) => b.category !== "time_off" && b.category !== "lunch");
              return held.length ? [`${r.label} (${held.map((b) => `${b.label.toLowerCase()} ${minutesToLabel(b.startMin)}`).join(", ")})`] : [];
            }),
          };
        })
        .filter((x) => x.working.length || x.off.length || x.blocked.length)
    : null;
  return {
    to: person.email,
    ...renderDigest({
      firstName: person.firstName,
      dateLabel: formatDate(today, "EEEE, MMMM d"),
      yesterdayLabel: formatDate(yesterday, "EEEE"),
      sales: pace ? pace.map((p) => ({ shop: p.shop, netCents: p.nowCents, tickets: p.tickets, priorCents: p.priorCents })) : null,
      staff: staffShops,
      alerts,
      link: `${appBaseUrl()}/admin`,
    }),
  };
}

/** Emails this person their own digest now, whatever the schedule says. */
export async function sendTestDigest(staffId: string, now: Date = new Date()) {
  const d = await buildDigest(staffId, now);
  if (!d) throw new AppError("conflict", "You have no open shops, so there's nothing to send");
  if (!d.to) throw new AppError("bad_request", "Add an email address to your profile first");
  const [job] = await db.insert(notificationJobs).values({ kind: "digest", channel: "email", to: d.to, subject: `[Test] ${d.subject}`, body: d.body, runAt: now }).returning({ id: notificationJobs.id });
  await processDueJobs({ ids: [job.id], now });
  return { to: d.to };
}

/** Whether any live shop opens today. */
async function anyShopOpen(today: string) {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(shopHours)
    .innerJoin(shops, eq(shops.id, shopHours.shopId))
    .where(
      and(
        eq(shopHours.weekday, weekdayOf(today)),
        eq(shops.status, "live"),
        sql`not exists (select 1 from ${shopClosures} c where c.shop_id = ${shops.id} and c.date = ${today})`,
      ),
    );
  return (r?.n ?? 0) > 0;
}

/**
 * Called by the notifications cron every few minutes: once it's past the send time (and before
 * noon), queues today's digest for each recipient who hasn't had it, then sends.
 */
export async function sendDueDigests(now: Date = new Date()) {
  const s = await loadDigestSettings();
  if (!s.enabled) return { queued: 0 };
  const today = todayLocal(now);
  if (now.getTime() < zonedWallTime(today, s.sendAtMin).toMillis() || now.getTime() > zonedWallTime(today, SEND_BY_MIN).toMillis()) return { queued: 0 };
  if (s.skipClosedDays && !(await anyShopOpen(today))) return { queued: 0 };
  const people = await digestRecipients(s);
  if (!people.length) return { queued: 0 };
  const done = new Set(
    (await db.select({ id: digestSends.staffId }).from(digestSends).where(and(eq(digestSends.date, today), inArray(digestSends.staffId, people.map((p) => p.staffId))))).map((r) => r.id),
  );
  const jobIds: string[] = [];
  for (const p of people.filter((x) => !done.has(x.staffId))) {
    const [claimed] = await db.insert(digestSends).values({ date: today, staffId: p.staffId }).onConflictDoNothing().returning({ id: digestSends.staffId });
    if (!claimed) continue;
    const d = await buildDigest(p.staffId, now, s);
    if (!d?.to) continue;
    const [job] = await db.insert(notificationJobs).values({ kind: "digest", channel: "email", to: d.to, subject: d.subject, body: d.body, runAt: now }).returning({ id: notificationJobs.id });
    await db.update(digestSends).set({ jobId: job.id }).where(and(eq(digestSends.date, today), eq(digestSends.staffId, p.staffId)));
    jobIds.push(job.id);
  }
  if (jobIds.length) await processDueJobs({ ids: jobIds, now });
  return { queued: jobIds.length };
}
