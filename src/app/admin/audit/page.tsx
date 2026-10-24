import type { Metadata } from "next";
import Link from "next/link";
import { Fragment } from "react";
import { db } from "@/db";
import { auditLog } from "@/db/schema";
import { Card, Empty, Input, PageHeader, Select, Table, Td, Th, buttonClass } from "@/components/ui";
import { formatDateTime } from "@/lib/time";
import { auditScope } from "@/server/audit";
import { can, guardPage, reasonViewer } from "@/server/auth/staff";
import { clientPolicy } from "@/server/client-privacy";
import { auditRows } from "@/server/report-data";
import { LocationField, LocationNotice, ViewInput, ViewToggle, locationProps, reportQuery, withView } from "../reports/filters";
import { ReportTabs } from "../reports/report-view";
import { resolveLocations } from "../reports/scope";

export const metadata: Metadata = { title: "Audit log" };

const PAGE = 100;

export default async function AuditPage({ searchParams }: { searchParams: Promise<{ q?: string; entity?: string; page?: string; shop?: string | string[]; view?: string }> }) {
  const sp = await searchParams;
  const ctx = await guardPage("/admin/audit");
  const page = Math.max(0, Number(sp.page) || 0);
  const q = sp.q?.trim();
  const l = await resolveLocations(ctx, sp);

  const [rows, areas] = await Promise.all([
    auditRows({ viewer: ctx, client: await clientPolicy(ctx), reasons: reasonViewer(ctx), loc: l.loc, q, entity: sp.entity, limit: PAGE + 1, offset: page * PAGE }),
    db
      .selectDistinct({ entity: auditLog.entity })
      .from(auditLog)
      .where(auditScope({ ...ctx, currentShopId: null }))
      .orderBy(auditLog.entity),
  ]);
  const more = rows.length > PAGE;
  const filters = { q: q || null, entity: sp.entity || null };
  const qs = (p: number) => `/admin/audit?${reportQuery(l, { ...filters, page: String(p) })}`;
  const grouped = l.loc.view === "shops";

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Audit log"
        subtitle="Every sale, void, refund, price, tax, schedule, permission and settings change, with who did it. Entries can't be edited or deleted."
        actions={
          can(ctx, "report.audit_log.export") ? (
            <a className={buttonClass("secondary")} href={`/admin/reports/export?${reportQuery(l, { type: "audit_log", ...filters })}`}>
              Export CSV
            </a>
          ) : undefined
        }
      />
      <ReportTabs ctx={ctx} active="audit_log" />
      <form key={l.shopParam ?? ""} className="no-print mb-3 flex flex-wrap items-end gap-2 text-sm" method="get">
        {ctx.shops.length > 1 && <LocationField p={locationProps(ctx, l)} />}
        <Input name="q" defaultValue={q} placeholder="Search action, person, ID, details…" className="max-w-xs" />
        <Select name="entity" defaultValue={sp.entity ?? ""} className="max-w-48">
          <option value="">All areas</option>
          {areas.map(({ entity }) => (
            <option key={entity} value={entity}>
              {entity.replace(/_/g, " ")}
            </option>
          ))}
        </Select>
        <button className={buttonClass("secondary")}>Filter</button>
        <ViewInput l={l} />
        <div className="ml-auto self-center">
          <ViewToggle l={l} href={(v) => `/admin/audit?${reportQuery(withView(l, v), filters)}`} />
        </div>
      </form>
      <LocationNotice locations={l} />
      <Card>
        {rows.length === 0 ? (
          <Empty title="Nothing logged yet" />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>When</Th>
                <Th>Who</Th>
                <Th>Action</Th>
                <Th>Shop</Th>
                <Th>Details</Th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, PAGE).map(({ a, shop }, i, list) => (
                <Fragment key={a.id}>
                  {grouped && (i === 0 || list[i - 1].a.shopId !== a.shopId) && (
                    <tr className="bg-zinc-50">
                      <td colSpan={5} className="border-b border-zinc-200 px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-zinc-600">
                        {shop ?? "Brand"}
                      </td>
                    </tr>
                  )}
                  <tr className="align-top">
                    <Td className="whitespace-nowrap">{formatDateTime(a.at)}</Td>
                    <Td className="whitespace-nowrap">{a.actorLabel ?? "—"}</Td>
                    <Td className="whitespace-nowrap">
                      <span className="font-mono text-xs">{a.action}</span>
                      {a.entityId && <div className="max-w-40 truncate font-mono text-[11px] text-zinc-400">{a.entityId}</div>}
                    </Td>
                    <Td className="whitespace-nowrap">{shop ?? "Brand"}</Td>
                    <Td>
                      <Details value={a.details} />
                    </Td>
                  </tr>
                </Fragment>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      <div className="mt-3 flex justify-between text-sm">
        {page > 0 ? <Link href={qs(page - 1)}>‹ Newer</Link> : <span />}
        {more && <Link href={qs(page + 1)}>Older ›</Link>}
      </div>
    </div>
  );
}

function Details({ value }: { value: unknown }) {
  if (!value || (typeof value === "object" && Object.keys(value).length === 0)) return <span className="text-zinc-400">—</span>;
  const text = JSON.stringify(value);
  if (text.length <= 140) return <code className="break-all text-xs text-zinc-600">{text}</code>;
  return (
    <details>
      <summary className="cursor-pointer text-xs text-zinc-600">{text.slice(0, 120)}…</summary>
      <pre className="mt-1 max-w-xl overflow-x-auto rounded bg-zinc-50 p-2 text-[11px]">{JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}
