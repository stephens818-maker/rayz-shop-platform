import type { Metadata } from "next";
import Link from "next/link";
import { Badge, Card, CardHeader, Notice, PageHeader, Stat, Table, Td, Th } from "@/components/ui";
import { jurisdictionGroups, ratePct } from "@/domain/tax-fees";
import { formatCents } from "@/lib/money";
import { addDays, todayLocal } from "@/lib/time";
import { guardPage } from "@/server/auth/staff";
import { taxesAndFees } from "@/server/taxes-fees";

export const metadata: Metadata = { title: "Taxes and card fees" };

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export default async function TaxesPage({ searchParams }: { searchParams: Promise<{ from?: string; to?: string }> }) {
  const ctx = await guardPage("/admin/taxes");
  const sp = await searchParams;
  const to = sp.to && DATE.test(sp.to) ? sp.to : todayLocal();
  const from = sp.from && DATE.test(sp.from) && sp.from <= to ? sp.from : addDays(to, -29);
  const rows = await taxesAndFees(ctx.shopIds, from, to);
  const groups = jurisdictionGroups(rows);
  const tax = rows.reduce((a, r) => a + r.serviceTaxCents + r.productTaxCents, 0);
  const fees = rows.reduce((a, r) => a + r.cardFeeCents, 0);
  const unverified = rows.filter((r) => !r.verified);
  const edit = (shopId: string) => `/admin/settings?shop=${shopId}`;
  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <PageHeader
        title="Taxes and card fees"
        subtitle="Two separate models. Sales tax is owed to a jurisdiction and set per location; the card fee is a processing surcharge, never reported or filed as tax."
      />
      {unverified.length > 0 && <Notice>Tax rates aren&apos;t verified at {unverified.map((r) => r.shop).join(", ")}. Confirm them with your accountant in each shop&apos;s settings.</Notice>}
      <form className="flex flex-wrap items-end gap-2 text-sm">
        <label className="flex flex-col text-xs text-zinc-500">
          From
          <input type="date" name="from" defaultValue={from} className="rounded-md border border-zinc-300 px-2 py-1 text-sm text-zinc-900" />
        </label>
        <label className="flex flex-col text-xs text-zinc-500">
          To
          <input type="date" name="to" defaultValue={to} className="rounded-md border border-zinc-300 px-2 py-1 text-sm text-zinc-900" />
        </label>
        <button className="rounded-md bg-ink-900 px-3 py-1.5 text-sm font-medium text-white">Show</button>
      </form>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Sales tax collected" value={formatCents(tax)} hint={`${from} to ${to}`} />
        <Stat label="Card fees collected" value={formatCents(fees)} hint="kept apart from tax" />
        <Stat label="Jurisdictions" value={groups.length} hint={`${rows.length} locations`} />
        <Stat label="Unverified rates" value={unverified.length} tone={unverified.length ? "down" : undefined} />
      </div>
      <Card>
        <CardHeader title="Sales tax by jurisdiction" subtitle="Rates are fractions of the taxable amount after discounts. Shops in the same jurisdiction should match." />
        <Table>
          <thead>
            <tr>
              <Th>Jurisdiction</Th>
              <Th>Location</Th>
              <Th right>Service rate</Th>
              <Th right>Product rate</Th>
              <Th>Verified</Th>
              <Th right>Service tax</Th>
              <Th right>Product tax</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {groups.flatMap((g) =>
              g.shops.map((r, i) => {
                const full = rows.find((x) => x.shopId === r.shopId)!;
                return (
                  <tr key={r.shopId}>
                    <Td className="font-medium">
                      {i === 0 && (
                        <>
                          {g.jurisdiction}
                          {g.mismatch && (
                            <Badge tone="amber" className="ml-2">
                              rates differ
                            </Badge>
                          )}
                        </>
                      )}
                    </Td>
                    <Td>{r.shop}</Td>
                    <Td right>{ratePct(r.serviceTaxRate)}</Td>
                    <Td right>{ratePct(r.productTaxRate)}</Td>
                    <Td>{r.verified ? <Badge tone="green">Verified</Badge> : <Badge tone="amber">Placeholder</Badge>}</Td>
                    <Td right>{formatCents(full.serviceTaxCents)}</Td>
                    <Td right>{formatCents(full.productTaxCents)}</Td>
                    <Td right>
                      <Link href={edit(r.shopId)} className="text-xs text-brand-700 hover:underline">
                        Edit
                      </Link>
                    </Td>
                  </tr>
                );
              }),
            )}
          </tbody>
        </Table>
      </Card>
      <Card>
        <CardHeader title="Card fees" subtitle="The surcharge on card payments. It isn't taxed, isn't part of sales, and goes to the shop to cover processing." />
        <Table>
          <thead>
            <tr>
              <Th>Location</Th>
              <Th>Card fee</Th>
              <Th right>Rate</Th>
              <Th>On tips</Th>
              <Th right>Tickets</Th>
              <Th right>Collected</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.shopId}>
                <Td className="font-medium">{r.shop}</Td>
                <Td>{r.cardFeeEnabled ? <Badge tone="blue">On</Badge> : <Badge>Off</Badge>}</Td>
                <Td right>{r.cardFeeEnabled ? ratePct(r.cardFeeRate) : "—"}</Td>
                <Td>{r.cardFeeEnabled ? (r.cardFeeAppliesToTip ? "Yes" : "No") : "—"}</Td>
                <Td right>{r.tickets}</Td>
                <Td right>{formatCents(r.cardFeeCents)}</Td>
                <Td right>
                  <Link href={edit(r.shopId)} className="text-xs text-brand-700 hover:underline">
                    Edit
                  </Link>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>
    </div>
  );
}
