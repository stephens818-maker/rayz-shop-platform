import "server-only";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  or,
  sql,
} from "drizzle-orm";
import { db } from "@/db";
import { staff, staffMilestoneRules, staffMilestones } from "@/db/schema";
import {
  type MilestoneKind,
  type MilestoneMetric,
  type MilestoneSettings,
  SHOP_SHOWN,
  WELCOME_DAYS,
  dayLine,
  welcomeLine,
} from "@/domain/milestones";
import { addDays, todayLocal } from "@/lib/time";
import { type Actor, audit } from "../audit";
import { rows, uuids } from "../report-sql";
import { loadMilestoneSettings, milestoneSettingsAt, runMilestones } from "./engine";

/** A milestone reached today, as the shop sees it: by first name, nothing about money or ratings. */
export interface Celebration {
  id: string;
  staffId: string;
  firstName: string;
  kind: MilestoneKind;
  text: string;
  at: string;
}

const builtIn = sql<boolean>`coalesce(${staffMilestoneRules.builtIn} and ${staffMilestoneRules.key} = ${staffMilestones.metric}, false)`;

/**
 * What's being celebrated today at these shops: milestones of people who work there (or, with
 * "every location" on, anyone's), unless they've turned sharing off. `since` keeps only those
 * recorded after it, for the live toast.
 */
export async function celebrationsAt(
  shopIds: string[],
  o: {
    now?: Date;
    s?: MilestoneSettings;
    since?: Date;
    kinds?: readonly MilestoneKind[];
  } = {},
): Promise<Celebration[]> {
  const s = o.s ?? (await loadMilestoneSettings());
  if (!s.enabled || !shopIds.length) return [];
  const metrics = [...SHOP_SHOWN].filter(
    (m: MilestoneMetric) => s.birthdays || m !== "birthday",
  );
  const list = await db
    .select({
      id: staffMilestones.id,
      staffId: staffMilestones.staffId,
      firstName: staff.firstName,
      kind: staffMilestones.kind,
      metric: staffMilestones.metric,
      threshold: staffMilestones.threshold,
      value: staffMilestones.value,
      title: staffMilestones.title,
      createdAt: staffMilestones.createdAt,
      builtIn,
    })
    .from(staffMilestones)
    .innerJoin(staff, eq(staff.id, staffMilestones.staffId))
    .leftJoin(
      staffMilestoneRules,
      eq(staffMilestoneRules.id, staffMilestones.ruleId),
    )
    .where(
      and(
        eq(staffMilestones.achievedOn, todayLocal(o.now ?? new Date())),
        eq(staffMilestones.silent, false),
        inArray(staffMilestones.metric, metrics),
        o.kinds ? inArray(staffMilestones.kind, [...o.kinds]) : undefined,
        o.since ? gt(staffMilestones.createdAt, o.since) : undefined,
        eq(staff.kind, "person"),
        eq(staff.active, true),
        isNull(staff.removedAt),
        eq(staff.milestonesShared, true),
        s.allLocations
          ? undefined
          : or(
              inArray(staffMilestones.shopId, shopIds),
              sql`exists (select 1 from staff_shops ss where ss.staff_id = ${staffMilestones.staffId} and ss.shop_id in ${uuids(shopIds)})`,
            ),
      ),
    )
    .orderBy(asc(staffMilestones.createdAt), asc(staffMilestones.threshold));
  return list.map((m) => ({
    id: m.id,
    staffId: m.staffId,
    firstName: m.firstName,
    kind: m.kind,
    text: dayLine(m.firstName, m),
    at: m.createdAt.toISOString(),
  }));
}

/**
 * After a ticket is paid: the counts its barbers just reached (Jamie's 1,000th cut), recorded right
 * away so the shop's live toast and banners show them. Their alert emails go out with the queue.
 */
export async function checkoutMilestones(saleId: string, now = new Date()) {
  const barbers = await rows<{ id: string }>(sql`
    select distinct x id from (
      select coalesce(si.staff_id, s.staff_id) x from sales s left join sale_items si on si.sale_id = s.id where s.id = ${saleId}
      union
      select a.staff_id from appointments a, sales s
        where s.id = ${saleId} and (a.id = s.appointment_id or a.id in (select si.appointment_id from sale_items si where si.sale_id = ${saleId}))
    ) t where x is not null`);
  if (!barbers.length) return { recorded: 0, announced: 0, emails: 0 };
  return runMilestones(now, {
    staffIds: barbers.map((b) => b.id),
    kinds: ["count"],
    send: false,
  });
}

export interface ShopDay {
  /** For the calendar's banner, when it's on. */
  calendar: Celebration[];
  /** For the Sales & checkout and POS banner, when it's on. */
  pos: Celebration[];
  /** Calendar column badges by person, when they're on. */
  badges: Record<string, string[]>;
}

/** Today's banners and calendar badges at a shop, as the brand set them up. */
export async function shopDay(
  shopIds: string[],
  now = new Date(),
): Promise<ShopDay> {
  const s = shopIds.length === 1 ? await milestoneSettingsAt(shopIds[0]) : await loadMilestoneSettings();
  const wanted =
    s.enabled && (s.calendarBanner || s.posBanner || s.columnBadge);
  const list = wanted ? await celebrationsAt(shopIds, { now, s }) : [];
  const badges: Record<string, string[]> = {};
  if (s.columnBadge)
    for (const c of list) (badges[c.staffId] ??= []).push(c.text);
  return {
    calendar: s.calendarBanner ? list : [],
    pos: s.posBanner ? list : [],
    badges,
  };
}

export interface WelcomeItem {
  id: string;
  kind: MilestoneKind;
  text: string;
}

/**
 * What to congratulate them on when they clock in or open their portal: what they haven't seen
 * yet from the last week, or with `todayOnly` (the shared front-desk clock) from today. Without
 * `money` a sales record leaves the amount out.
 */
export async function welcomeFor(
  staffId: string,
  o: {
    now?: Date;
    todayOnly?: boolean;
    money?: boolean;
    s?: MilestoneSettings;
  } = {},
): Promise<WelcomeItem[]> {
  const s = o.s ?? (await loadMilestoneSettings());
  if (!s.enabled || !s.welcomeModal) return [];
  const today = todayLocal(o.now ?? new Date());
  const list = await db
    .select({
      id: staffMilestones.id,
      kind: staffMilestones.kind,
      metric: staffMilestones.metric,
      threshold: staffMilestones.threshold,
      value: staffMilestones.value,
      title: staffMilestones.title,
      builtIn,
    })
    .from(staffMilestones)
    .leftJoin(
      staffMilestoneRules,
      eq(staffMilestoneRules.id, staffMilestones.ruleId),
    )
    .where(
      and(
        eq(staffMilestones.staffId, staffId),
        eq(staffMilestones.silent, false),
        isNull(staffMilestones.seenAt),
        o.todayOnly
          ? eq(staffMilestones.achievedOn, today)
          : gte(staffMilestones.achievedOn, addDays(today, -WELCOME_DAYS)),
        s.birthdays ? undefined : sql`${staffMilestones.kind} <> 'birthday'`,
      ),
    )
    .orderBy(desc(staffMilestones.achievedOn), desc(staffMilestones.threshold));
  return list.map((m) => ({
    id: m.id,
    kind: m.kind,
    text: welcomeLine(m, { money: o.money ?? true }),
  }));
}

export interface Welcome {
  firstName: string;
  items: WelcomeItem[];
}

/**
 * On clocking in: their congratulations, marked seen as it's shown. The shared front-desk clock
 * leaves sales amounts out. A failure here never fails the punch.
 */
export async function clockInWelcome(
  staffId: string,
  actor: Actor,
  via: "clock" | "kiosk",
): Promise<Welcome | null> {
  try {
    const items = await welcomeFor(staffId, { money: via === "clock" });
    if (!items.length) return null;
    const [p] = await db
      .select({ firstName: staff.firstName })
      .from(staff)
      .where(eq(staff.id, staffId));
    await markWelcomed(
      staffId,
      items.map((i) => i.id),
      actor,
      via,
    );
    return { firstName: p?.firstName ?? "", items };
  } catch (e) {
    console.error("milestone welcome on clock-in failed", (e as Error).message);
    return null;
  }
}

/** Marks what a punch just congratulated them on as seen, so their portal doesn't ask again. */
export async function markWelcomed(
  staffId: string,
  ids: string[],
  actor: Actor,
  via: "clock" | "kiosk" | "app",
) {
  if (!ids.length) return 0;
  const got = await db
    .update(staffMilestones)
    .set({ seenAt: new Date() })
    .where(
      and(
        eq(staffMilestones.staffId, staffId),
        inArray(staffMilestones.id, ids),
        isNull(staffMilestones.seenAt),
      ),
    )
    .returning({ id: staffMilestones.id });
  if (got.length)
    await audit(
      actor,
      "milestone.seen",
      "staff_milestone",
      got.length === 1 ? got[0].id : null,
      { ids: got.map((g) => g.id), via },
      null,
    );
  return got.length;
}
