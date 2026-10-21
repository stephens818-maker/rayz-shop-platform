import type { Metadata } from "next";
import Link from "next/link";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { brandSettings, vendors } from "@/db/schema";
import { Badge, Card, Empty, LinkButton, PageHeader, Stat, Table, Td, Th, cx } from "@/components/ui";
import { PO_STATUSES, PO_STATUS_LABEL, PoStatus, needsApproval, poNumber } from "@/domain/inventory";
import { formatCents } from "@/lib/money";
import { formatDate, formatDateTime } from "@/lib/time";
import { can, guardPage } from "@/server/auth/staff";
import { listPos } from "@/server/inventory/purchasing";
import { NewPoForm } from "./editor";
import { PO_TONE } from "./tone";

export const metadata: Metadata = { title: "Purchase orders" };

export default async function PurchaseOrdersPage({ searchParams }: { searchParams: Promise<{ status?: string; batch?: string; vendor?: string }> }) {
  const ctx = await guardPage("/admin/purchase-orders");
  const sp = await searchParams;
  const shopIds = ctx.currentShopId ? [ctx.currentShopId] : ctx.shopIds;
  const status = sp.status === "all" ? undefined : (PO_STATUSES.find((s) => s === sp.status) ?? (sp.batch || sp.vendor ? undefined : "open"));
  const [list, all, vendorRows, [brand]] = await Promise.all([
    listPos(shopIds, { status, batchId: sp.batch, vendorId: sp.vendor }),
    listPos(shopIds, { status: "open", limit: 1000 }),
    db.select({ id: vendors.id, name: vendors.name }).from(vendors).where(eq(vendors.active, true)).orderBy(asc(vendors.name)),
    db.select({ t: brandSettings.poApprovalThresholdCents }).from(brandSettings).limit(1),
  ]);
  const limit = brand?.t ?? null;
  const count = (s: PoStatus) => all.filter((p) => p.status === s).length;
  const awaiting = all.filter((p) => p.status === "draft" && needsApproval(p.totalCents, limit)).length;
  const tabs: { key: string; label: string }[] = [
    { key: "open", label: "Open" },
    ...PO_STATUSES.map((s) => ({ key: s, label: PO_STATUS_LABEL[s] })),
    { key: "all", label: "All" },
  ];
  const active = sp.status ?? (sp.batch || sp.vendor ? "all" : "open");

  return (
    <div className="mx-auto max-w-7xl space-y-5">
      <PageHeader
        title="Purchase orders"
        subtitle={
          <>
            Draft, approve, send to the vendor, and receive against.{" "}
            {limit !== null ? `Orders over ${formatCents(limit)} need approval before they're sent.` : "No approval step is set."}
          </>
        }
        actions={
          <LinkButton href="/admin/inventory/low-stock" variant="secondary">
            Suggested orders
          </LinkButton>
        }
      />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Drafts" value={count("draft")} hint={awaiting ? `${awaiting} over the approval limit` : undefined} tone={awaiting ? "down" : undefined} />
        <Stat label="Approved, not sent" value={count("approved")} />
        <Stat label="Waiting on delivery" value={count("sent") + count("partially_received")} hint={`${count("partially_received")} partly received`} />
        <Stat label="On order" value={formatCents(all.filter((p) => p.status !== "draft").reduce((a, p) => a + p.totalCents, 0))} hint="approved, sent and partly received, at order cost" />
      </div>
      {can(ctx, "po.create") && <NewPoForm vendors={vendorRows} shops={ctx.shops.filter((s) => shopIds.includes(s.id))} />}
      <Card>
        <div className="flex flex-wrap gap-1 border-b border-zinc-100 px-3 py-2">
          {tabs.map((t) => (
            <Link
              key={t.key}
              href={t.key === "open" ? "/admin/purchase-orders" : `/admin/purchase-orders?status=${t.key}`}
              className={cx("rounded-md px-2.5 py-1 text-sm", active === t.key ? "bg-ink-900 text-white" : "text-zinc-600 hover:bg-zinc-100")}
            >
              {t.label}
            </Link>
          ))}
          {(sp.batch || sp.vendor) && <span className="ml-2 self-center text-xs text-zinc-500">Filtered {sp.batch ? "to one batch" : "to one vendor"} · <Link href="/admin/purchase-orders" className="underline">clear</Link></span>}
        </div>
        {list.length === 0 ? (
          <div className="p-4">
            <Empty title="No purchase orders here">Create one above, or from the suggested orders on the Low stock page.</Empty>
          </div>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>PO</Th>
                <Th>Status</Th>
                <Th>Vendor</Th>
                {shopIds.length > 1 && <Th>Shop</Th>}
                <Th right>Lines</Th>
                <Th right>Units</Th>
                <Th right>Total</Th>
                <Th>Created</Th>
                <Th>Sent</Th>
                <Th>Expected</Th>
              </tr>
            </thead>
            <tbody>
              {list.map((p) => (
                <tr key={p.id} className="hover:bg-zinc-50">
                  <Td>
                    <Link href={`/admin/purchase-orders/${p.id}`} className="font-medium text-brand-700 hover:underline">
                      {poNumber(p.number)}
                    </Link>
                    {p.batchId && (
                      <Link href={`/admin/purchase-orders?batch=${p.batchId}`} className="ml-1 text-[11px] text-zinc-400 hover:underline">
                        batch
                      </Link>
                    )}
                  </Td>
                  <Td>
                    <Badge tone={PO_TONE[p.status]}>{PO_STATUS_LABEL[p.status]}</Badge>
                    {p.status === "draft" && needsApproval(p.totalCents, limit) && <div className="mt-0.5 text-[11px] text-amber-700">needs approval</div>}
                    {p.closedShort && <div className="mt-0.5 text-[11px] text-zinc-500">closed short</div>}
                  </Td>
                  <Td>{p.vendor}</Td>
                  {shopIds.length > 1 && <Td>{p.shop}</Td>}
                  <Td right>{p.lines}</Td>
                  <Td right>
                    {p.status === "partially_received" ? `${p.received} / ${p.units}` : p.units}
                  </Td>
                  <Td right className="font-medium">
                    {formatCents(p.totalCents)}
                  </Td>
                  <Td className="text-zinc-600">
                    {formatDateTime(p.createdAt)}
                    {p.createdBy && <div className="text-xs text-zinc-400">{p.createdBy}</div>}
                  </Td>
                  <Td className="text-zinc-600">{p.sentAt ? formatDateTime(p.sentAt) : "—"}</Td>
                  <Td className="text-zinc-600">{p.expectedOn ? formatDate(p.expectedOn) : "—"}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      {can(ctx, "report.purchasing.view") && (
        <div className="text-sm text-zinc-500">
          Spend by vendor, lead times and fill rates: <Link href="/admin/reports/purchasing" className="underline">Purchase orders and vendor spend report</Link>.
        </div>
      )}
    </div>
  );
}
