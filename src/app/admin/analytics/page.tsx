import type { Metadata } from "next";
import Link from "next/link";
import { sql } from "drizzle-orm";
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Field,
  Input,
  Notice,
  PageHeader,
  Select,
  Table,
  Td,
  Th,
  buttonClass,
} from "@/components/ui";
import { db } from "@/db";
import {
  BACKFILL_TABLES,
  CATEGORIES,
  EVENTS,
  type EventDef,
} from "@/domain/analytics";
import {
  DEFAULT_EVENT_REPORT,
  encodeDefinition,
} from "@/domain/report-builder";
import { addDays, formatDate, formatDateTime, todayLocal } from "@/lib/time";
import { loadAnalyticsSettings, warehouseRuns } from "@/server/analytics";
import { can, guardPage, openShops } from "@/server/auth/staff";
import { isBrandLevelViewer } from "@/server/client-privacy";
import { AnalyticsSettingsEditor, BackfillButton } from "./editor";

export const metadata: Metadata = { title: "Event log" };
export const dynamic = "force-dynamic";

const MEASURES = [
  "minutes",
  "value",
  "amount",
  "quantity",
  "subtype",
  "reason",
] as const;

export default async function AnalyticsPage() {
  const ctx = await guardPage("/admin/analytics");
  const today = todayLocal();
  const since = addDays(today, -29);
  const [settings, byCategory, [totals], runs] = await Promise.all([
    loadAnalyticsSettings(),
    db.execute(
      sql`select category, count(*)::int n from analytics_events where business_date >= ${since}::date group by category order by n desc`,
    ) as unknown as Promise<{ category: string; n: number }[]>,
    db.execute(
      sql`select count(*)::int n, min(business_date)::text first from analytics_events`,
    ) as unknown as Promise<{ n: number; first: string | null }[]>,
    warehouseRuns(5),
  ]);
  const editsSettings = can(ctx, "analytics.settings");
  const exports =
    can(ctx, "analytics.export") && ctx.brandWide && isBrandLevelViewer(ctx);
  const builds =
    can(ctx, "analytics.events") && can(ctx, "report_builder.build");
  const left = BACKFILL_TABLES.filter((t) => !settings.backfilled.includes(t));
  const warehouseAddress = !!process.env.ANALYTICS_WAREHOUSE_URL;
  const catalog = Object.entries(EVENTS as Record<string, EventDef>);

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <PageHeader
        title="Event log"
        subtitle="Every meaningful action is logged as it happens: bookings and the online booking funnel, check-in to checkout, ticket edits, refunds and voids, tips, stock, clock punches, block-outs, messages, calls and more, with when, where, who did it and how. It's append-only and holds ids and numbers, never contact details or card data, so any metric can be worked out later."
        actions={
          builds ? (
            <Link
              className={buttonClass("secondary")}
              href={`/admin/reports/custom/new?d=${encodeDefinition(DEFAULT_EVENT_REPORT)}`}
            >
              Build an event report
            </Link>
          ) : undefined
        }
      />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <Card>
          <CardHeader
            title="Last 30 days"
            subtitle={`${totals.n.toLocaleString("en-US")} events logged in all${totals.first ? `, since ${formatDate(totals.first, "MMM d, yyyy")}` : ""}.`}
          />
          {byCategory.length ? (
            <Table>
              <thead>
                <tr>
                  <Th>Category</Th>
                  <Th right>Events</Th>
                </tr>
              </thead>
              <tbody>
                {byCategory.map((c) => (
                  <tr key={c.category}>
                    <Td>
                      {CATEGORIES[c.category as keyof typeof CATEGORIES] ??
                        c.category}
                    </Td>
                    <Td right>{c.n.toLocaleString("en-US")}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          ) : (
            <p className="px-4 py-6 text-sm text-zinc-500">
              Nothing logged in the last 30 days.
            </p>
          )}
        </Card>
        <div className="space-y-4 self-start">
          {editsSettings && (
            <AnalyticsSettingsEditor
              initial={{
                satisfaction: settings.satisfaction,
                warehouse: settings.warehouse,
              }}
              warehouseAddress={warehouseAddress}
            />
          )}
          <Card>
            <CardHeader
              title="History"
              subtitle="Visits, tickets, punches and messages from before the log started are logged once, marked as backfilled, by the nightly job."
            />
            <div className="space-y-2 px-4 py-3 text-sm">
              {left.length ? (
                <p className="text-zinc-700">
                  {BACKFILL_TABLES.length - left.length} of{" "}
                  {BACKFILL_TABLES.length} kinds of record done. Still to do:{" "}
                  {left.map((t) => t.replace(/_/g, " ")).join(", ")}.
                </p>
              ) : (
                <p className="text-zinc-700">All history is logged.</p>
              )}
              {editsSettings && left.length > 0 && <BackfillButton />}
            </div>
          </Card>
          <Card>
            <CardHeader
              title="Warehouse copy"
              subtitle={
                settings.warehouse
                  ? warehouseAddress
                    ? "On: new events are copied each night."
                    : "On, but no warehouse address is set on the server."
                  : "Off."
              }
            />
            {runs.length ? (
              <ul className="divide-y divide-zinc-100 text-sm">
                {runs.map((r) => (
                  <li
                    key={r.id}
                    className="flex items-center justify-between gap-2 px-4 py-2"
                  >
                    <span>
                      {formatDateTime(r.startedAt)}
                      {r.failure && (
                        <span className="block text-xs text-red-700">
                          {r.failure}
                        </span>
                      )}
                    </span>
                    <span className="text-right">
                      <Badge
                        tone={
                          r.status === "done"
                            ? "green"
                            : r.status === "failed"
                              ? "red"
                              : "amber"
                        }
                      >
                        {r.status}
                      </Badge>
                      <span className="block text-xs text-zinc-500">
                        {r.rows.toLocaleString("en-US")} rows
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-4 py-3 text-sm text-zinc-500">No copies yet.</p>
            )}
          </Card>
        </div>
      </div>

      {exports ? (
        <Card>
          <CardHeader
            title="Download the raw log"
            subtitle="CSV, one row per event, every column in the schema below. For a BI tool; every download is in the audit log."
          />
          <form
            method="get"
            action="/admin/analytics/export"
            className="grid gap-3 px-4 py-3 sm:grid-cols-5 sm:items-end"
          >
            <Field label="From">
              <Input type="date" name="from" defaultValue={since} required />
            </Field>
            <Field label="To">
              <Input type="date" name="to" defaultValue={today} required />
            </Field>
            <Field label="Category">
              <Select name="category" defaultValue="">
                <option value="">Every category</option>
                {Object.entries(CATEGORIES).map(([k, l]) => (
                  <option key={k} value={k}>
                    {l}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Location">
              <Select name="shop" defaultValue="">
                <option value="">Every location</option>
                {openShops(ctx).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Button type="submit">Download CSV</Button>
          </form>
        </Card>
      ) : (
        can(ctx, "analytics.export") && (
          <Notice tone="blue">
            The raw log can only be downloaded by brand-level roles with access
            to every location.
          </Notice>
        )
      )}

      <Card>
        <CardHeader
          title="What's logged"
          subtitle="Each event's code, and what its measure columns hold. The same list is in the README."
        />
        <div className="overflow-x-auto">
          <Table>
            <thead>
              <tr>
                <Th>Event</Th>
                <Th>Code</Th>
                <Th>Measures</Th>
              </tr>
            </thead>
            <tbody>
              {catalog.map(([k, e]) => (
                <tr key={k}>
                  <Td>{e.label}</Td>
                  <Td>
                    <code className="text-xs">{k}</code>
                  </Td>
                  <Td className="text-xs text-zinc-600">
                    {MEASURES.filter((x) => e[x])
                      .map((x) => `${x}: ${e[x]}`)
                      .join(" · ") || "—"}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
      </Card>
    </div>
  );
}
