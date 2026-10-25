import type { Metadata } from "next";
import Link from "next/link";
import {
  Card,
  CardHeader,
  Empty,
  LinkButton,
  Notice,
  PageHeader,
} from "@/components/ui";
import { MilestoneGlyph, TrophyCase } from "@/components/trophy-case";
import {
  type MilestoneSettings,
  congratsLine,
  whenLabel,
} from "@/domain/milestones";
import { formatDate, todayLocal } from "@/lib/time";
import { type StaffContext, can, guardPage } from "@/server/auth/staff";
import { type Person, loadMilestoneSettings } from "@/server/milestones/engine";
import {
  type Line,
  congratsFor,
  milestoneViewer,
  personFor,
  progressFor,
  teamFeed,
  teamOverview,
  trophyCase,
} from "@/server/milestones/views";
import { CheerButton, DismissCongrats, MyMilestonePrefs } from "./client";

export const metadata: Metadata = { title: "Milestones" };
export const dynamic = "force-dynamic";

export default async function MilestonesPage({
  searchParams,
}: {
  searchParams: Promise<{ staff?: string }>;
}) {
  const ctx = await guardPage("/admin/milestones");
  const sp = await searchParams;
  const s = await loadMilestoneSettings();
  const mayReport = can(ctx, "report.milestones.view");
  const maySettings = can(ctx, "milestones.settings");
  const actions = (
    <div className="flex gap-2">
      {mayReport && (
        <LinkButton
          size="sm"
          variant="secondary"
          href="/admin/reports/milestones"
        >
          Report
        </LinkButton>
      )}
      {maySettings && (
        <LinkButton
          size="sm"
          variant="secondary"
          href="/admin/milestones/settings"
        >
          Settings
        </LinkButton>
      )}
    </div>
  );
  if (!s.enabled)
    return (
      <div className="mx-auto max-w-4xl space-y-4">
        <PageHeader title="Milestones" actions={actions} />
        <Empty title="Staff milestones are off">
          {maySettings
            ? "Turn them on under Settings."
            : "The brand can turn them on."}
        </Empty>
      </div>
    );
  const now = new Date();
  const v = await milestoneViewer(ctx);
  if (
    sp.staff &&
    /^[0-9a-f-]{36}$/i.test(sp.staff) &&
    sp.staff !== ctx.staff.id
  ) {
    const p = await personFor(v, s, sp.staff);
    if (!p)
      return (
        <div className="mx-auto max-w-4xl space-y-4">
          <PageHeader title="Milestones" actions={actions} />
          <Empty title="Not available">
            Their milestones are private, or they aren&rsquo;t at a shop you
            manage.
          </Empty>
        </div>
      );
    return (
      <PersonView
        ctx={ctx}
        person={p}
        settings={s}
        now={now}
        actions={actions}
      />
    );
  }
  const me = ctx.staff.kind === "person";
  const [congrats, overview, feed, mine] = await Promise.all([
    me ? congratsFor(ctx.staff.id, now, s) : [],
    teamOverview(v, s, now, { recentDays: 14 }),
    teamFeed(v, s, now),
    me ? personFor(v, s, ctx.staff.id) : null,
  ]);
  const mayCelebrate = can(ctx, "campaign_center.create");
  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <PageHeader
        title="Milestones"
        subtitle="Cuts, clients, anniversaries, personal bests and streaks, counted from every visit including Squire history."
        actions={actions}
      />
      {!me && (
        <Notice tone="blue">
          This is a shop login. Sign in as yourself to see your own milestones.
        </Notice>
      )}
      {congrats.length > 0 && <Congrats items={congrats} />}
      {overview.people > 0 && (
        <TeamOverview
          recent={overview.recent}
          upcoming={overview.upcoming}
          mayCelebrate={mayCelebrate}
        />
      )}
      {s.teamFeed && (
        <Card>
          <CardHeader
            title="Team shout-outs"
            subtitle="New milestones from teammates at your shops who share theirs. Cheer them on; sales amounts aren't shown here."
          />
          {feed.length ? (
            <ul className="divide-y divide-zinc-100" data-testid="team-feed">
              {feed.map((f) => (
                <li
                  key={f.milestoneId}
                  className="flex flex-wrap items-start gap-3 px-4 py-3 text-sm"
                >
                  <div className="min-w-0 flex-1">
                    <div className="font-medium text-zinc-900">{f.text}</div>
                    <div className="text-xs text-zinc-500">
                      {formatDate(f.on, "EEE, MMM d")}
                    </div>
                    {f.cheers.length > 0 && (
                      <ul className="mt-1.5 space-y-0.5 text-xs text-zinc-600">
                        {f.cheers.map((c, i) => (
                          <li key={i}>
                            <span className="font-medium">
                              {c.mine ? "You" : c.label}
                            </span>
                            {c.message ? `: ${c.message}` : " cheered"}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  {!f.mine && me && (
                    <CheerButton
                      milestoneId={f.milestoneId}
                      cheered={f.cheers.some((c) => c.mine)}
                      count={f.cheers.length}
                    />
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-4 py-6 text-sm text-zinc-500">
              No shout-outs in the last 30 days.
            </p>
          )}
        </Card>
      )}
      {mine && <OwnSections person={mine} settings={s} now={now} />}
    </div>
  );
}

function Congrats({
  items,
}: {
  items: Awaited<ReturnType<typeof congratsFor>>;
}) {
  return (
    <Card className="overflow-hidden" data-testid="milestone-congrats">
      <div className="flex flex-wrap items-center gap-3 bg-gradient-to-r from-amber-100 via-amber-50 to-white px-4 py-3">
        <MilestoneGlyph kind="count" className="size-6 text-amber-600" />
        <div className="flex-1">
          <div className="text-sm font-semibold text-zinc-900">
            Congratulations!
          </div>
          <div className="text-sm text-zinc-700">
            {items.map(congratsLine).join(" · ")}
          </div>
        </div>
        <DismissCongrats ids={items.map((m) => m.id)} />
      </div>
    </Card>
  );
}

function LineList({
  lines,
  mayCelebrate,
  empty,
  today,
}: {
  lines: Line[];
  mayCelebrate: boolean;
  empty: string;
  today: string;
}) {
  if (!lines.length)
    return <p className="px-4 py-6 text-sm text-zinc-500">{empty}</p>;
  return (
    <ul className="divide-y divide-zinc-100">
      {lines.map((l, i) => (
        <li
          key={l.milestoneId ?? `${l.staffId}:${i}`}
          className="flex flex-wrap items-center gap-2 px-4 py-2.5 text-sm"
        >
          <Link
            href={`/admin/milestones?staff=${l.staffId}`}
            className="min-w-0 flex-1 text-zinc-900 hover:underline"
          >
            {l.text}
          </Link>
          {l.milestoneId && (
            <span className="text-xs text-zinc-500">
              {whenLabel(l.on, today)}
            </span>
          )}
          {mayCelebrate && l.celebrate && l.milestoneId && (
            <Link
              href={`/admin/campaign-center/blasts/new?celebrate=${l.milestoneId}`}
              className="text-xs font-medium text-brand-700 hover:underline"
            >
              Celebrate with clients
            </Link>
          )}
        </li>
      ))}
    </ul>
  );
}

function TeamOverview({
  recent,
  upcoming,
  mayCelebrate,
}: {
  recent: Line[];
  upcoming: Line[];
  mayCelebrate: boolean;
}) {
  const today = todayLocal();
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card>
        <CardHeader
          title="Just reached"
          subtitle="Your team's milestones from the last 14 days. A shout-out goes a long way."
        />
        <LineList
          lines={recent}
          mayCelebrate={mayCelebrate}
          empty="Nothing in the last two weeks."
          today={today}
        />
      </Card>
      <Card>
        <CardHeader
          title="Coming up"
          subtitle="From today's bookings, anniversaries and each person's pace."
        />
        <LineList
          lines={upcoming}
          mayCelebrate={false}
          empty="Nothing due in the coming days."
          today={today}
        />
      </Card>
    </div>
  );
}

async function Progress({
  person,
  now,
  own,
}: {
  person: Person;
  now: Date;
  own: boolean;
}) {
  const p = await progressFor(person, now);
  const started =
    p.counts.some((c) => c.total > 0) || p.streaks.some((st) => st.longest > 0);
  return (
    <div className="space-y-4 p-4 text-sm">
      <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-[10rem_1fr]">
        <dt className="text-zinc-500">With the brand</dt>
        <dd>
          {p.tenure ??
            (own
              ? "No hire date on file yet. Ask a manager to add it to your profile."
              : "No hire date on file yet. Add it on their staff profile.")}
        </dd>
        {p.nextAnniversary && (
          <>
            <dt className="text-zinc-500">Next anniversary</dt>
            <dd>
              {p.nextAnniversary.years}{" "}
              {p.nextAnniversary.years === 1 ? "year" : "years"} on{" "}
              {formatDate(p.nextAnniversary.on, "MMM d, yyyy")}
            </dd>
          </>
        )}
      </dl>
      {!started ? (
        <p className="text-zinc-500">
          Nothing counted yet. Cuts, clients and products count from the first
          completed appointment or sale.
        </p>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {p.counts.map((c) => (
            <li
              key={c.ruleId}
              className="rounded-lg p-3 ring-1 ring-inset ring-zinc-200"
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-medium text-zinc-900">{c.name}</span>
                <span className="tabular-nums text-zinc-700">
                  {c.total.toLocaleString("en-US")}
                </span>
              </div>
              <div
                className="mt-2 h-2 overflow-hidden rounded-full bg-zinc-100"
                role="progressbar"
                aria-valuenow={Math.round(c.pct * 100)}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label={c.name}
              >
                <div
                  className="h-full rounded-full bg-brand-600"
                  style={{ width: `${Math.round(c.pct * 100)}%` }}
                />
              </div>
              <div className="mt-1 text-xs text-zinc-500">
                {c.next
                  ? `${(c.next - c.total).toLocaleString("en-US")} more to ${c.next.toLocaleString("en-US")} ${c.unit}`
                  : "Every level reached"}
              </div>
            </li>
          ))}
          {p.streaks.map((st) => (
            <li
              key={st.ruleId}
              className="rounded-lg p-3 ring-1 ring-inset ring-zinc-200"
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-medium text-zinc-900">{st.name}</span>
                <span className="tabular-nums text-zinc-700">
                  {st.current} now
                </span>
              </div>
              <div className="mt-1 text-xs text-zinc-500">
                Longest {st.longest}
                {st.next ? ` · next badge at ${st.next}` : ""}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

async function OwnSections({
  person,
  settings: s,
  now,
}: {
  person: Person;
  settings: MilestoneSettings;
  now: Date;
}) {
  const t = await trophyCase(person.id);
  return (
    <>
      <Card>
        <CardHeader
          title="My trophy case"
          subtitle="Everything you've reached, including history from Squire."
        />
        <TrophyCase trophies={t.trophies} bests={t.bests} />
      </Card>
      <Card>
        <CardHeader
          title="On the way"
          subtitle="How close you are to the next one."
        />
        <Progress person={person} now={now} own />
      </Card>
      {(s.birthdays || s.teamFeed || s.celebrate) && (
        <Card>
          <CardHeader
            title="My preferences"
            subtitle="Only you can change these."
          />
          <MyMilestonePrefs
            birthdays={s.birthdays}
            birthday={
              person.birthdayMonth && person.birthdayDay
                ? { month: person.birthdayMonth, day: person.birthdayDay }
                : null
            }
            shared={person.shared}
            teamFeed={s.teamFeed}
            celebrate={s.celebrate}
            onTheDay={
              s.calendarBanner || s.posBanner || s.columnBadge || s.liveToast
            }
          />
        </Card>
      )}
    </>
  );
}

async function PersonView({
  ctx,
  person,
  settings: s,
  now,
  actions,
}: {
  ctx: StaffContext;
  person: Person & { rel: string };
  settings: MilestoneSettings;
  now: Date;
  actions: React.ReactNode;
}) {
  const manage = person.rel === "manage";
  const [t, overview] = await Promise.all([
    trophyCase(person.id),
    manage
      ? teamOverview(await milestoneViewer(ctx), s, now, {
          staffIds: [person.id],
        })
      : null,
  ]);
  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <PageHeader
        title={`${person.label}'s milestones`}
        subtitle={
          <Link href="/admin/milestones" className="underline">
            Milestones
          </Link>
        }
        actions={actions}
      />
      {overview &&
        (overview.recent.length > 0 || overview.upcoming.length > 0) && (
          <TeamOverview
            recent={overview.recent}
            upcoming={overview.upcoming}
            mayCelebrate={can(ctx, "campaign_center.create")}
          />
        )}
      <Card>
        <CardHeader
          title="Trophy case"
          subtitle={
            manage
              ? undefined
              : "Shared with the team. Sales amounts stay with their managers."
          }
        />
        <TrophyCase
          trophies={t.trophies}
          bests={t.bests}
          money={manage}
          empty="No milestones yet."
        />
      </Card>
      {manage && (
        <Card>
          <CardHeader title="On the way" />
          <Progress person={person} now={now} own={false} />
        </Card>
      )}
    </div>
  );
}
