import "server-only";
import { and, desc, eq, gte, inArray, isNull, lte, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  marketingTemplates,
  shops,
  staff,
  staffMilestoneCheers,
  staffMilestones,
  staffShops,
} from "@/db/schema";
import {
  CHANNELS,
  type Channel,
  type Segment,
  SegmentSchema,
  type Templates,
} from "@/domain/marketing";
import {
  CONGRATS_DAYS,
  FEED_DAYS,
  type MilestoneKind,
  type MilestoneMetric,
  type MilestoneSettings,
  type MilestoneViewer,
  METRICS,
  SHAREABLE,
  type StreakMetric,
  anniversaryDate,
  clientPhrase,
  recordedSentence,
  recordedTitle,
  ruleUnit,
  seesMilestonesOf,
  streakHits,
  tenureLabel,
  thresholdProgress,
  upcomingSentence,
} from "@/domain/milestones";
import {
  type Column,
  type ListRow,
  type ViewCtx,
  listTable,
} from "@/domain/report-views";
import { LocalDate, addDays, formatDate, todayLocal } from "@/lib/time";
import { recordEvent } from "../analytics";
import { audit } from "../audit";
import { type StaffContext, can } from "../auth/staff";
import { AppError, forbidden, notFound } from "../errors";
import type { ReportData } from "../report-data";
import { type ReportScope, staffSelection } from "../report-sql";
import { type WelcomeItem, welcomeFor } from "./day";
import {
  type Person,
  countTotals,
  ensureMilestoneDefaults,
  loadMilestoneSettings,
  loadRules,
  people,
  streakEvents,
  upcomingFor,
} from "./engine";

export async function milestoneViewer(
  ctx: Pick<StaffContext, "staff" | "access" | "brandWide">,
): Promise<MilestoneViewer> {
  const viewShops = ctx.access.shops
    .filter((s) =>
      ctx.access.byShop.get(s.id)?.permissions.has("milestones.view"),
    )
    .map((s) => s.id);
  const workShops =
    ctx.staff.kind === "shop"
      ? ctx.access.shopIds
      : (
          await db
            .select({ id: staffShops.shopId })
            .from(staffShops)
            .where(eq(staffShops.staffId, ctx.staff.id))
        ).map((x) => x.id);
  return {
    staffId: ctx.staff.id,
    brand: ctx.brandWide && ctx.access.permissions.has("milestones.view"),
    viewShops,
    workShops,
  };
}

export type Relation = "own" | "manage" | "team";
const relationOf = (v: MilestoneViewer, p: Person, s: MilestoneSettings) =>
  seesMilestonesOf(
    v,
    { staffId: p.id, workShops: p.workShops, shared: p.shared },
    s.teamFeed,
  );

/** The people whose milestones this viewer may see, with why. */
export async function visiblePeople(
  v: MilestoneViewer,
  s: MilestoneSettings,
  only?: Relation[],
) {
  const all = await people();
  return all.flatMap((p) => {
    const rel = relationOf(v, p, s);
    return rel && (!only || only.includes(rel)) ? [{ ...p, rel }] : [];
  });
}

/** One person, if the viewer may see their milestones. */
export async function personFor(
  v: MilestoneViewer,
  s: MilestoneSettings,
  staffId: string,
) {
  const [p] = await people([staffId]);
  const rel = p ? relationOf(v, p, s) : null;
  return p && rel ? { ...p, rel } : null;
}

const shopNameMap = async () =>
  new Map(
    (await db.select({ id: shops.id, name: shops.name }).from(shops)).map(
      (x) => [x.id, x.name],
    ),
  );

export interface MilestoneItem {
  id: string;
  staffId: string;
  kind: MilestoneKind;
  metric: string;
  threshold: number | null;
  value: number | null;
  title: string;
  achievedOn: LocalDate;
  shop: string | null;
  silent: boolean;
}

const itemOf = (
  m: typeof staffMilestones.$inferSelect,
  names: Map<string, string>,
): MilestoneItem => ({
  id: m.id,
  staffId: m.staffId,
  kind: m.kind,
  metric: m.metric,
  threshold: m.threshold,
  value: m.value,
  title: m.title,
  achievedOn: m.achievedOn,
  shop: m.shopId ? (names.get(m.shopId) ?? null) : null,
  silent: m.silent,
});

/** Their trophy case: everything reached but birthdays, newest first, and their current personal bests. */
export async function trophyCase(staffId: string) {
  const [list, names] = await Promise.all([
    db
      .select()
      .from(staffMilestones)
      .where(
        and(
          eq(staffMilestones.staffId, staffId),
          ne(staffMilestones.kind, "birthday"),
        ),
      )
      .orderBy(
        desc(staffMilestones.achievedOn),
        desc(staffMilestones.threshold),
      ),
    shopNameMap(),
  ]);
  const items = list.map((m) => itemOf(m, names));
  const latestBest = new Map<string, MilestoneItem>();
  for (const m of [...items]
    .filter((x) => x.kind === "best")
    .sort((a, b) => b.achievedOn.localeCompare(a.achievedOn)))
    if (!latestBest.has(m.metric)) latestBest.set(m.metric, m);
  const order = Object.keys(METRICS);
  return {
    trophies: items.filter((m) => m.kind !== "best"),
    bests: [...latestBest.values()].sort(
      (a, b) => order.indexOf(a.metric) - order.indexOf(b.metric),
    ),
  };
}

/** How far they are to the next of each count and streak, and their time with the brand. */
export async function progressFor(p: Person, now: Date) {
  const today = todayLocal(now);
  const rules = await loadRules({ activeOnly: true, shopId: p.workShops[0] });
  const counts = await Promise.all(
    rules
      .filter((r) => r.kind === "count")
      .map(async (r) => {
        const t = (await countTotals(r, [p.id], now)).get(p.id) ?? {
          total: 0,
          recent: 0,
          laterToday: 0,
        };
        return {
          ruleId: r.id,
          name: r.name,
          unit: ruleUnit(r),
          total: t.total,
          ...thresholdProgress(r.thresholds, t.total),
        };
      }),
  );
  const streaks = await Promise.all(
    rules
      .filter((r) => r.kind === "streak")
      .map(async (r) => {
        const ev =
          (await streakEvents(r.metric as StreakMetric, [p.id])).get(p.id) ??
          [];
        const s = streakHits(ev, r.thresholds);
        return {
          ruleId: r.id,
          name: r.name,
          current: s.current,
          longest: s.longest,
          next: r.thresholds.find((t) => t > s.current) ?? null,
        };
      }),
  );
  const years = rules.find((r) => r.kind === "anniversary")?.thresholds ?? [];
  const nextYears = p.hireDate
    ? years.find((y) => anniversaryDate(p.hireDate!, y) > today)
    : undefined;
  return {
    counts,
    streaks,
    tenure: p.hireDate ? tenureLabel(p.hireDate, today) : null,
    nextAnniversary:
      p.hireDate && nextYears
        ? { years: nextYears, on: anniversaryDate(p.hireDate, nextYears) }
        : null,
  };
}

/** New milestones to congratulate them on in their portal, until they dismiss them. */
export async function congratsFor(
  staffId: string,
  now: Date,
  s?: MilestoneSettings,
) {
  const settings = s ?? (await loadMilestoneSettings());
  if (!settings.enabled || !settings.congratulate) return [];
  const since = addDays(todayLocal(now), -CONGRATS_DAYS);
  const list = await db
    .select()
    .from(staffMilestones)
    .where(
      and(
        eq(staffMilestones.staffId, staffId),
        eq(staffMilestones.silent, false),
        isNull(staffMilestones.seenAt),
        gte(staffMilestones.achievedOn, since),
      ),
    )
    .orderBy(desc(staffMilestones.achievedOn));
  const names = await shopNameMap();
  return list.map((m) => itemOf(m, names));
}

export async function markSeen(ctx: StaffContext, ids: string[]) {
  if (!ids.length) return 0;
  const got = await db
    .update(staffMilestones)
    .set({ seenAt: new Date() })
    .where(
      and(
        eq(staffMilestones.staffId, ctx.staff.id),
        inArray(staffMilestones.id, ids),
        isNull(staffMilestones.seenAt),
      ),
    )
    .returning({ id: staffMilestones.id });
  if (got.length)
    await audit(
      ctx.actor,
      "milestone.seen",
      "staff_milestone",
      got.length === 1 ? got[0].id : null,
      { ids: got.map((g) => g.id) },
      null,
    );
  return got.length;
}

export interface Line {
  staffId: string;
  label: string;
  text: string;
  on: LocalDate;
  milestoneId?: string;
  celebrate?: boolean;
}

/** For managers: what their people reached lately and what's coming up. */
export async function teamOverview(
  v: MilestoneViewer,
  s: MilestoneSettings,
  now: Date,
  o: {
    recentDays?: number;
    staffIds?: string[];
    shopIds?: string[];
    horizon?: number;
  } = {},
) {
  const team = (await visiblePeople(v, s, ["manage"])).filter(
    (p) =>
      (!o.staffIds || o.staffIds.includes(p.id)) &&
      (!o.shopIds || p.workShops.some((id) => o.shopIds!.includes(id))),
  );
  if (!team.length || !s.enabled)
    return { recent: [] as Line[], upcoming: [] as Line[], people: 0 };
  const today = todayLocal(now);
  const label = new Map(team.map((p) => [p.id, p.label]));
  const list = await db
    .select()
    .from(staffMilestones)
    .where(
      and(
        inArray(
          staffMilestones.staffId,
          team.map((p) => p.id),
        ),
        eq(staffMilestones.silent, false),
        gte(
          staffMilestones.achievedOn,
          addDays(today, -(o.recentDays ?? FEED_DAYS)),
        ),
        s.birthdays ? undefined : ne(staffMilestones.kind, "birthday"),
      ),
    )
    .orderBy(desc(staffMilestones.achievedOn), desc(staffMilestones.createdAt))
    .limit(100);
  const recent = list.map((m) => ({
    staffId: m.staffId,
    label: label.get(m.staffId)!,
    text: recordedSentence(label.get(m.staffId)!, m),
    on: m.achievedOn,
    milestoneId: m.id,
    celebrate:
      s.celebrate &&
      SHAREABLE.has(m.metric as MilestoneMetric) &&
      team.find((p) => p.id === m.staffId)!.shared,
  }));
  const upcoming = (
    await upcomingFor(team, now, o.horizon ?? s.upcomingDays, s)
  ).map((u) => ({
    staffId: u.staffId,
    label: label.get(u.staffId)!,
    text: upcomingSentence(label.get(u.staffId)!, u, today),
    on: u.on,
  }));
  return { recent, upcoming, people: team.length };
}

// ───────────────────────────── Team feed ─────────────────────────────

/** For the Today page: their own new milestones, and their team's from today and the next two days. */
export async function todayMilestones(
  ctx: StaffContext,
  shopIds: string[],
  now: Date,
) {
  const s = await loadMilestoneSettings();
  if (!s.enabled)
    return {
      congrats: [] as MilestoneItem[],
      team: [] as Line[],
      welcome: [] as WelcomeItem[],
    };
  const v = await milestoneViewer(ctx);
  const person = ctx.staff.kind === "person";
  const [congrats, overview, welcome] = await Promise.all([
    person ? congratsFor(ctx.staff.id, now, s) : [],
    v.brand || v.viewShops.length
      ? teamOverview(v, s, now, { recentDays: 0, horizon: 2, shopIds })
      : null,
    person ? welcomeFor(ctx.staff.id, { now, s }) : [],
  ]);
  const team = overview ? [...overview.recent, ...overview.upcoming] : [];
  return { congrats, team: team.slice(0, 6), welcome };
}

export interface FeedItem extends Line {
  milestoneId: string;
  mine: boolean;
  cheers: { label: string; message: string | null; mine: boolean }[];
}

/**
 * The team feed: new milestones of teammates who share theirs, at the shops the viewer works at.
 * Sales records leave the amount out.
 */
export async function teamFeed(
  v: MilestoneViewer,
  s: MilestoneSettings,
  now: Date,
): Promise<FeedItem[]> {
  if (!s.enabled || !s.teamFeed || !v.workShops.length) return [];
  const all = await people();
  const team = all.filter(
    (p) => p.shared && p.workShops.some((x) => v.workShops.includes(x)),
  );
  if (!team.length) return [];
  const label = new Map(all.map((p) => [p.id, p.label]));
  const list = await db
    .select()
    .from(staffMilestones)
    .where(
      and(
        inArray(
          staffMilestones.staffId,
          team.map((p) => p.id),
        ),
        eq(staffMilestones.silent, false),
        gte(staffMilestones.achievedOn, addDays(todayLocal(now), -FEED_DAYS)),
        s.birthdays ? undefined : ne(staffMilestones.kind, "birthday"),
      ),
    )
    .orderBy(desc(staffMilestones.achievedOn), desc(staffMilestones.createdAt))
    .limit(50);
  const cheers = list.length
    ? await db
        .select({
          milestoneId: staffMilestoneCheers.milestoneId,
          staffId: staffMilestoneCheers.staffId,
          message: staffMilestoneCheers.message,
          label: staff.displayLabel,
        })
        .from(staffMilestoneCheers)
        .innerJoin(staff, eq(staff.id, staffMilestoneCheers.staffId))
        .where(
          inArray(
            staffMilestoneCheers.milestoneId,
            list.map((m) => m.id),
          ),
        )
        .orderBy(staffMilestoneCheers.createdAt)
    : [];
  return list.map((m) => ({
    staffId: m.staffId,
    label: label.get(m.staffId) ?? "",
    text: recordedSentence(label.get(m.staffId) ?? "", m, { money: false }),
    on: m.achievedOn,
    milestoneId: m.id,
    mine: m.staffId === v.staffId,
    cheers: cheers
      .filter((c) => c.milestoneId === m.id)
      .map((c) => ({
        label: c.label,
        message: c.message,
        mine: c.staffId === v.staffId,
      })),
  }));
}

export async function cheerMilestone(
  ctx: StaffContext,
  milestoneId: string,
  message: string | null,
) {
  const s = await loadMilestoneSettings();
  if (!s.enabled || !s.teamFeed)
    throw new AppError("conflict", "The team feed is off");
  if (ctx.staff.kind !== "person")
    throw forbidden("Cheers come from people; sign in as yourself");
  const m = await db.query.staffMilestones.findFirst({
    where: eq(staffMilestones.id, milestoneId),
  });
  if (!m || m.silent) throw notFound("Milestone");
  const v = await milestoneViewer(ctx);
  const p = await personFor(v, s, m.staffId);
  if (!p) throw notFound("Milestone");
  if (p.rel === "own")
    throw new AppError("bad_request", "You can't cheer your own milestone");
  const text = message?.trim() ? message.trim().slice(0, 140) : null;
  const [row] = await db
    .insert(staffMilestoneCheers)
    .values({ milestoneId, staffId: ctx.staff.id, message: text })
    .onConflictDoUpdate({
      target: [staffMilestoneCheers.milestoneId, staffMilestoneCheers.staffId],
      set: { message: text },
    })
    .returning({ createdAt: staffMilestoneCheers.createdAt });
  await audit(
    ctx.actor,
    "milestone.cheer",
    "staff_milestone",
    milestoneId,
    { staffId: m.staffId, message: text },
    m.shopId,
  );
  await recordEvent({
    event: "milestone.cheered",
    key: `milestone_cheer:${milestoneId}:${ctx.staff.id}`,
    shop: m.shopId ?? undefined,
    staff: m.staffId,
    actor: ctx.staff.id,
    actorKind: "staff",
    entity: "staff_milestone",
    entityId: milestoneId,
    subtype: m.kind,
  });
  return { at: row.createdAt };
}

export async function uncheerMilestone(ctx: StaffContext, milestoneId: string) {
  const got = await db
    .delete(staffMilestoneCheers)
    .where(
      and(
        eq(staffMilestoneCheers.milestoneId, milestoneId),
        eq(staffMilestoneCheers.staffId, ctx.staff.id),
      ),
    )
    .returning({ id: staffMilestoneCheers.milestoneId });
  if (got.length)
    await audit(
      ctx.actor,
      "milestone.uncheer",
      "staff_milestone",
      milestoneId,
      {},
      null,
    );
  return got.length > 0;
}

// ───────────────────────────── Celebrate with clients ─────────────────────────────

export async function celebrateTemplate() {
  const find = () =>
    db.query.marketingTemplates.findFirst({
      where: eq(marketingTemplates.purpose, "milestone"),
    });
  let t = await find();
  if (!t) {
    await ensureMilestoneDefaults();
    t = await find();
  }
  return t?.status === "approved" ? t : null;
}

export interface CelebrateDraft {
  name: string;
  templateId: string;
  channels: Channel[];
  templates: Templates;
  segment: Segment;
  shopIds: string[];
}

/**
 * A blast for a barber's recent clients to celebrate a milestone with them, from the brand's approved
 * template: their first name only, and the milestone said plainly. Only for milestones about the
 * work (cuts, clients, anniversaries), barbers who share theirs, and people who may draft blasts
 * and see the barber's milestones.
 */
export async function celebrateDraft(
  ctx: StaffContext,
  milestoneId: string,
): Promise<CelebrateDraft | null> {
  if (!can(ctx, "campaign_center.create")) return null;
  const s = await loadMilestoneSettings();
  if (!s.enabled || !s.celebrate) return null;
  const m = await db.query.staffMilestones.findFirst({
    where: eq(staffMilestones.id, milestoneId),
  });
  if (!m || m.silent) return null;
  const phrase = clientPhrase(m);
  if (!phrase) return null;
  const v = await milestoneViewer(ctx);
  const p = await personFor(v, s, m.staffId);
  if (!p || p.rel !== "manage" || !p.shared) return null;
  const t = await celebrateTemplate();
  if (!t) return null;
  const person = await db.query.staff.findFirst({
    where: eq(staff.id, m.staffId),
    columns: { firstName: true },
  });
  const first = (person?.firstName ?? p.label).trim().split(/\s+/)[0];
  const fill = (x: string) =>
    x.replaceAll("{barber}", first).replaceAll("a big milestone", phrase);
  return {
    name: `Celebrate ${first}: ${m.title}`,
    templateId: t.id,
    channels: t.channels.filter((c): c is Channel =>
      (CHANNELS as readonly string[]).includes(c),
    ),
    templates: Object.fromEntries(
      Object.entries(t.templates ?? {}).map(([k, x]) => [k, fill(String(x))]),
    ) as unknown as Templates,
    segment: SegmentSchema.parse({
      staffIds: [m.staffId],
      barberMatch: "any",
      lastVisitWithinDays: 365,
    }),
    shopIds: p.workShops.filter((id) => ctx.shopIds.includes(id)),
  };
}

// ───────────────────────────── Report ─────────────────────────────

const KIND_WORD: Record<MilestoneKind, string> = {
  count: "Count",
  anniversary: "Anniversary",
  birthday: "Birthday",
  best: "Personal best",
  streak: "Streak",
};

/** Milestones reached in the range at the selected shops and barbers. Birthdays stay out of reports. */
export async function milestonesReportData(
  scope: ReportScope,
  loc: ViewCtx,
): Promise<ReportData> {
  if (!scope.shopIds.length) return { stats: [], tables: [] };
  const sel = staffSelection(scope);
  const list = await db
    .select({ m: staffMilestones, label: staff.displayLabel })
    .from(staffMilestones)
    .innerJoin(staff, eq(staff.id, staffMilestones.staffId))
    .where(
      and(
        gte(staffMilestones.achievedOn, scope.from),
        lte(staffMilestones.achievedOn, scope.to),
        ne(staffMilestones.kind, "birthday"),
        inArray(staffMilestones.shopId, scope.shopIds),
        sel
          ? sel.length
            ? inArray(staffMilestones.staffId, sel)
            : sql`false`
          : undefined,
      ),
    )
    .orderBy(desc(staffMilestones.achievedOn), staff.displayLabel);
  const rowsOut: ListRow[] = list.map(({ m, label }) => ({
    shopId: m.shopId!,
    staffId: m.staffId,
    cells: [
      formatDate(m.achievedOn, "EEE, MMM d, yyyy"),
      label,
      recordedTitle(m),
      KIND_WORD[m.kind],
      m.silent ? "" : "Yes",
      1,
    ],
  }));
  const columns: Column[] = [
    { label: "Reached" },
    { label: "Barber" },
    { label: "Milestone" },
    { label: "Kind" },
    { label: "Announced" },
    { label: "Milestones", kind: "int" },
  ];
  const announced = list.filter((x) => !x.m.silent).length;
  const kinds = (["count", "anniversary", "best", "streak"] as const).map(
    (k) => [k, list.filter((x) => x.m.kind === k).length] as const,
  );
  return {
    stats: [
      {
        label: "Milestones reached",
        value: String(list.length),
        hint: `${new Set(list.map((x) => x.m.staffId)).size} people`,
      },
      {
        label: "Announced",
        value: String(announced),
        hint:
          list.length > announced
            ? `${list.length - announced} found after the fact (history, a hire date or Squire totals)`
            : undefined,
      },
      ...kinds
        .filter(([, n]) => n > 0)
        .map(([k, n]) => ({
          label: KIND_WORD[k] === "Count" ? "Counts" : `${KIND_WORD[k]}s`,
          value: String(n),
        })),
    ].slice(0, 4),
    tables: [
      listTable(loc, {
        id: "milestones",
        title: "Milestones reached",
        subtitle:
          "Each one once, on the day it was reached, at the shop where it happened (anniversaries at their main shop). Announced ones went to the brand and their managers.",
        columns,
        rows: rowsOut,
        keepShop: true,
      }),
    ],
    notes: [
      "Birthdays are never in reports. Totals include imported Squire history and the Squire totals the brand entered under Setup → Staff milestones.",
    ],
  };
}
