import type { Metadata } from "next";
import Link from "next/link";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { staff } from "@/db/schema";
import { Badge, Card, CardHeader, Empty, LinkButton, PageHeader, Table, Td, Th } from "@/components/ui";
import { ACCESS_KINDS } from "@/domain/client-privacy";
import { formatDateTime } from "@/lib/time";
import { guardPage } from "@/server/auth/staff";
import { ACCESS_PERIODS, accessEntries, accessSummary, openAlerts, parseAccessFilters, recentAlerts } from "@/server/client-access-report";
import { AcknowledgeAlert } from "../editor";

export const metadata: Metadata = { title: "Client data access" };

const PAGE = 200;
const KIND_TONE = { view: "gray", search: "gray", list: "gray", reveal: "amber", export: "red", contact: "blue", blocked: "red" } as const;

export default async function ClientAccessPage({ searchParams }: { searchParams: Promise<{ days?: string; who?: string; kind?: string; client?: string; page?: string }> }) {
  const sp = await searchParams;
  await guardPage("/admin/client-data/access");
  const f = parseAccessFilters(sp);
  const page = Math.max(0, Number(sp.page) || 0);
  const [rows, summary, alerts, handled, people] = await Promise.all([
    accessEntries(f, PAGE + 1, page * PAGE),
    accessSummary(f),
    openAlerts(),
    recentAlerts(),
    db.select({ id: staff.id, label: staff.displayLabel }).from(staff).where(eq(staff.kind, "person")).orderBy(asc(staff.displayLabel)),
  ]);
  const more = rows.length > PAGE;
  const qs = (over: Record<string, string | null>) => {
    const q = new URLSearchParams();
    const all = { days: f.days, who: f.staffId ?? null, kind: f.kind ?? null, client: f.customerId ?? null, ...over };
    for (const [k, v] of Object.entries(all)) if (v) q.set(k, v);
    return q.toString();
  };

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <PageHeader
        title="Client data access"
        subtitle="Who opened, searched, revealed, exported or contacted which clients. Reveals record the field and the reason given."
        actions={
          <div className="flex gap-2">
            <LinkButton variant="secondary" href="/admin/client-data">
              Protection settings
            </LinkButton>
            <LinkButton variant="secondary" href={`/admin/client-data/access/export?${qs({})}`}>
              Export CSV
            </LinkButton>
          </div>
        }
      />
      {alerts.length > 0 && (
        <Card className="ring-red-200">
          <CardHeader title={`Unusual lookups (${alerts.length})`} subtitle="Brand admins were emailed when these happened." />
          <ul className="divide-y divide-zinc-100 text-sm">
            {alerts.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2">
                <span>
                  <Badge tone={a.kind === "paused" ? "red" : "amber"}>{a.kind === "paused" ? "Paused" : "Unusual"}</Badge> <span className="font-medium">{a.actorLabel}</span>:{" "}
                  {a.profiles} profiles and {a.searches} searches in {a.windowMinutes} min · {formatDateTime(a.at)}
                  {a.staffId && (
                    <Link className="ml-2 text-xs underline" href={`/admin/client-data/access?${qs({ who: a.staffId, days: "1", kind: null, client: null })}`}>
                      See their lookups
                    </Link>
                  )}
                </span>
                <AcknowledgeAlert id={a.id} />
              </li>
            ))}
          </ul>
        </Card>
      )}
      <form className="flex flex-wrap gap-2 text-sm" action="/admin/client-data/access">
        <select name="days" defaultValue={f.days} aria-label="Period" className="h-9 rounded-lg px-2 ring-1 ring-zinc-300">
          {Object.entries(ACCESS_PERIODS).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        <select name="who" defaultValue={f.staffId ?? ""} aria-label="Person" className="h-9 rounded-lg px-2 ring-1 ring-zinc-300">
          <option value="">Everyone</option>
          {people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
        <select name="kind" defaultValue={f.kind ?? ""} aria-label="What" className="h-9 rounded-lg px-2 ring-1 ring-zinc-300">
          <option value="">Everything</option>
          {Object.entries(ACCESS_KINDS).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        {f.customerId && <input type="hidden" name="client" value={f.customerId} />}
        <button className="h-9 rounded-lg bg-ink-900 px-4 font-medium text-white">Show</button>
        {f.customerId && (
          <Link className="self-center text-xs underline" href={`/admin/client-data/access?${qs({ client: null })}`}>
            All clients
          </Link>
        )}
      </form>
      <Card>
        <CardHeader title="By person" subtitle={`${ACCESS_PERIODS[f.days]}. Profiles counts different clients opened.`} />
        {summary.length === 0 ? (
          <Empty title="No client lookups in this period" />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Person</Th>
                <Th right>Profiles</Th>
                <Th right>Reveals</Th>
                <Th right>Exports</Th>
                <Th right>Searches</Th>
                <Th right>Calls & texts</Th>
                <Th right>Paused</Th>
                <Th>Last</Th>
              </tr>
            </thead>
            <tbody>
              {summary.map((s) => (
                <tr key={s.staffId ?? s.who}>
                  <Td>
                    {s.staffId ? (
                      <Link className="underline" href={`/admin/client-data/access?${qs({ who: s.staffId })}`}>
                        {s.who}
                      </Link>
                    ) : (
                      s.who
                    )}
                  </Td>
                  <Td right>{s.profiles}</Td>
                  <Td right>{s.reveals}</Td>
                  <Td right>{s.exports}</Td>
                  <Td right>{s.searches}</Td>
                  <Td right>{s.contacts}</Td>
                  <Td right>{s.blocked}</Td>
                  <Td>{formatDateTime(new Date(s.last))}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      <Card>
        <CardHeader title="Every lookup" subtitle="Newest first." />
        {rows.length === 0 ? (
          <Empty title="Nothing matches" />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>When</Th>
                <Th>Who</Th>
                <Th>What</Th>
                <Th>Client</Th>
                <Th>Reason</Th>
                <Th>Shop</Th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, PAGE).map((r) => (
                <tr key={r.id} className="align-top">
                  <Td>{formatDateTime(r.at)}</Td>
                  <Td>{r.actorLabel}</Td>
                  <Td>
                    <Badge tone={KIND_TONE[r.kind]}>{r.what}</Badge>
                    {r.kind === "export" && r.detail && (
                      <div className="mt-1 text-[11px] text-zinc-500">
                        {String(r.detail.export ?? "")} · {String(r.detail.clients ?? r.detail.rows ?? "")} rows
                      </div>
                    )}
                  </Td>
                  <Td>
                    {r.customerId ? (
                      <Link className="underline" href={`/admin/client-data/access?${qs({ client: r.customerId })}`}>
                        {r.client}
                      </Link>
                    ) : (
                      "—"
                    )}
                  </Td>
                  <Td className="max-w-xs whitespace-normal text-zinc-600">{r.reason ?? ""}</Td>
                  <Td>{r.shop ?? "All shops"}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        {(page > 0 || more) && (
          <div className="flex justify-between px-4 py-3 text-sm">
            {page > 0 ? <Link href={`/admin/client-data/access?${qs({ page: String(page - 1) })}`}>‹ Newer</Link> : <span />}
            {more && <Link href={`/admin/client-data/access?${qs({ page: String(page + 1) })}`}>Older ›</Link>}
          </div>
        )}
      </Card>
      {handled.length > 0 && (
        <Card>
          <CardHeader title="Acknowledged alerts" />
          <ul className="divide-y divide-zinc-100 text-xs text-zinc-600">
            {handled.map((a) => (
              <li key={a.id} className="px-4 py-2">
                {a.kind === "paused" ? "Paused" : "Unusual"}: {a.actorLabel}, {a.profiles} profiles and {a.searches} searches · {formatDateTime(a.at)} · acknowledged{" "}
                {a.acknowledgedAt ? formatDateTime(a.acknowledgedAt) : ""}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
