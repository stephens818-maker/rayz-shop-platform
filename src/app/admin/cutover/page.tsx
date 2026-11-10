import type { Metadata } from "next";
import Link from "next/link";
import { Badge, Card, CardHeader, PageHeader, Table, Td, Th } from "@/components/ui";
import { formatDate, formatDateTime } from "@/lib/time";
import { guardPage } from "@/server/auth/staff";
import { listCutovers } from "@/server/cutover";
import { shopOnboardingCounts } from "@/server/tips/onboarding";
import { STAGE } from "./stages";

export const metadata: Metadata = { title: "Squire cutover" };

export default async function CutoverPage() {
  await guardPage("/admin/cutover");
  const rows = await listCutovers();
  const teams = await shopOnboardingCounts(rows.map((r) => r.shop.id));
  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <PageHeader
        title="Squire cutover"
        subtitle="Move one shop's online booking off Squire at a time. Turn booking off in Squire and record when, import what changed after it, reconcile Squire's final exports here to the cent, make sure everyone there has set up Ray'z Stripe payouts, then an owner signs off and the shop books here. The website and app follow within a minute; the desk books either way."
      />
      <Card>
        <CardHeader title="Shops" />
        <Table>
          <thead>
            <tr>
              <Th>Shop</Th>
              <Th>Stage</Th>
              <Th>Squire frozen</Th>
              <Th>Last reconciled</Th>
              <Th>Staff payouts set up</Th>
              <Th>Moved here</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.shop.id}>
                <Td>
                  <Link className="underline" href={`/admin/cutover/${r.shop.id}`}>
                    {r.shop.name}
                  </Link>
                </Td>
                <Td>
                  <Badge tone={STAGE[r.stage].tone}>{STAGE[r.stage].label}</Badge>
                  {r.staleBy.length > 0 && <div className="mt-1 text-xs text-amber-700">Imported again since; reconcile again</div>}
                </Td>
                <Td>{r.cutover?.squireFrozenAt ? formatDateTime(r.cutover.squireFrozenAt) : "—"}</Td>
                <Td>{r.cutover?.reconciledAt ? `${formatDateTime(r.cutover.reconciledAt)}${r.cutover.matched ? "" : " (differences)"}` : "—"}</Td>
                <Td>
                  {(() => {
                    const t = teams.get(r.shop.id);
                    if (!t?.total) return "—";
                    return <Badge tone={t.done === t.total ? "green" : "amber"}>{`${t.done} of ${t.total}`}</Badge>;
                  })()}
                  {r.cutover?.squireTipsEndOn && <div className="mt-1 text-xs text-zinc-500">Squire tips end {formatDate(r.cutover.squireTipsEndOn, "MMM d")}</div>}
                </Td>
                <Td>{r.cutover?.switchedAt && r.stage === "live" ? formatDateTime(r.cutover.switchedAt) : "—"}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>
    </div>
  );
}
