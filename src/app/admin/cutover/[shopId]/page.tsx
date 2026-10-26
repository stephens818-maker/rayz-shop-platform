import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, Card, CardHeader, Notice, PageHeader, Table, Td, Th } from "@/components/ui";
import type { CutoverSection } from "@/db/schema";
import { formatDateTime } from "@/lib/time";
import { can, guardPage } from "@/server/auth/staff";
import { handBackReport, listCutovers, REQUIRED_FILES } from "@/server/cutover";
import { inTenant } from "@/server/tenant";
import { Importer } from "../../import/importer";
import { STAGE } from "../stages";
import { FreezeForm, HandBackForm, ReconcileForm, SignOffButton } from "./client";

export const metadata: Metadata = { title: "Squire cutover" };

const SECTION_LABEL: Record<string, string> = { bookings: "Upcoming bookings", tickets: "Tickets", loyalty: "Loyalty", gift_cards: "Gift cards" };
const $ = (c: number | null) => (c === null ? "—" : `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function ShopCutoverPage({ params }: { params: Promise<{ shopId: string }> }) {
  const ctx = await guardPage("/admin/cutover/[shopId]");
  const { shopId } = await params;
  if (!UUID.test(shopId) || !(await inTenant(ctx, "shop", shopId))) notFound();
  const row = (await listCutovers()).find((r) => r.shop.id === shopId);
  if (!row) notFound();
  const { shop, cutover: c, stage } = row;
  const owner = can(ctx, "settings.brand");
  const rec = c?.reconciliation && c.squireFrozenAt && c.reconciledAt && c.reconciledAt > c.squireFrozenAt ? c.reconciliation : null;
  const report = stage === "live" ? await handBackReport(shopId) : null;

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <PageHeader
        title={`${shop.name}: Squire cutover`}
        subtitle={
          <>
            <Badge tone={STAGE[stage].tone}>{STAGE[stage].label}</Badge>{" "}
            <Link className="text-sm underline" href="/admin/cutover">
              All shops
            </Link>
          </>
        }
      />

      {stage !== "live" && (
        <>
          <Card>
            <CardHeader
              title="1. Turn off online booking in Squire"
              subtitle="In Squire, turn off online booking for this shop only (older Squire app builds keep booking a shop until Squire stops taking them). Then record when it went off. Bookings already in Squire come over in the delta import."
            />
            <div className="space-y-2 p-4 text-sm">
              {c?.squireFrozenAt && (
                <div>
                  Recorded: Squire booking off since <b>{formatDateTime(c.squireFrozenAt)}</b>
                  {row.by.freeze ? `, by ${row.by.freeze}` : ""}.
                </div>
              )}
              <FreezeForm shopId={shopId} />
            </div>
          </Card>

          {c?.squireFrozenAt && (
            <>
              <div>
                <div className="mb-2 text-sm font-medium text-zinc-700">2. Import what changed after the freeze</div>
                <Importer shop={{ id: shopId, name: shop.name }} kinds={["appointments", "transactions", "loyalty", "gift_cards"]} />
                {row.deltaRuns.length > 0 && (
                  <div className="mt-2 text-xs text-zinc-600">
                    Imported since the freeze: {row.deltaRuns.map((d) => `${d.kind} ${formatDateTime(d.createdAt)} (${d.inserted} added, ${d.updated} updated, ${d.skipped} skipped)`).join("; ")}
                  </div>
                )}
              </div>

              <Card>
                <CardHeader
                  title="3. Reconcile to the cent"
                  subtitle={`Upload Squire's final exports, taken after the freeze. ${REQUIRED_FILES.map((f) => SECTION_LABEL[f].toLowerCase()).join(", ")} are required; tickets when you have the export. Anything that differs and isn't explained by activity here since the import blocks the switch.`}
                />
                <div className="space-y-4 p-4">
                  <ReconcileForm shopId={shopId} />
                  {row.staleBy.length > 0 && <Notice tone="amber">Something was imported after the last reconciliation. Reconcile again.</Notice>}
                  {rec && (
                    <div className="space-y-3">
                      <Notice tone={c!.matched && !row.staleBy.length ? "green" : "red"}>
                        {c!.matched ? "Matched to the cent" : "Doesn't match yet"} on {formatDateTime(rec.at)}
                        {row.by.reconcile ? ` by ${row.by.reconcile}` : ""} ({rec.environment}).{" "}
                        {REQUIRED_FILES.filter((f) => !rec.sections[f]).length > 0 &&
                          `Still needed: ${REQUIRED_FILES.filter((f) => !rec.sections[f])
                            .map((f) => SECTION_LABEL[f].toLowerCase())
                            .join(", ")}.`}
                      </Notice>
                      {Object.entries(rec.sections).map(([k, s]) => (
                        <SectionView key={k} title={`${SECTION_LABEL[k]}${rec.files[k as keyof typeof rec.files] ? ` · ${rec.files[k as keyof typeof rec.files]}` : ""}`} s={s!} />
                      ))}
                    </div>
                  )}
                </div>
              </Card>

              <Card>
                <CardHeader
                  title="4. Sign off and switch"
                  subtitle="An owner signs off on the reconciliation above. Online booking for this shop then moves here: the website and app book it here, and the Squire link stops showing."
                />
                <div className="p-4">{owner ? <SignOffButton shopId={shopId} ready={stage === "reconciled"} /> : <div className="text-sm text-zinc-600">An owner signs off and switches.</div>}</div>
              </Card>
            </>
          )}
        </>
      )}

      {stage === "live" && report && (
        <Card>
          <CardHeader
            title="Books here"
            subtitle={
              c?.signedOffAt
                ? `Signed off and switched ${formatDateTime(c.signedOffAt)}${row.by.signOff ? ` by ${row.by.signOff}` : ""}.`
                : "This shop books here. If it ever has to go back to Squire, hand it back below."
            }
          />
          <div className="space-y-3 p-4 text-sm">
            <div className="font-medium">If it has to go back to Squire</div>
            <p className="text-zinc-600">
              Online booking moves back to the Squire link. Bookings already made here stay and the desk serves them; enter them in Squire from the list below so Squire&apos;s calendar is complete.
              Moving the shop here again starts over from step 1.
            </p>
            <ul className="list-disc pl-5 text-zinc-700">
              <li>
                {report.bookings.length} upcoming booking{report.bookings.length === 1 ? "" : "s"} made here
                {report.bookings.length > 0 && (
                  <>
                    {" "}
                    (
                    <a className="underline" href={`/admin/cutover/${shopId}/hand-back`}>
                      download for Squire
                    </a>
                    )
                  </>
                )}
              </li>
              <li>
                {report.cards.sold} gift card{report.cards.sold === 1 ? "" : "s"} sold here ({$(report.cards.sold_cents)}), {report.cards.redeemed} redemption
                {report.cards.redeemed === 1 ? "" : "s"} here ({$(report.cards.redeemed_cents)})
              </li>
              <li>
                {report.cards.rewards_earned} loyalty reward{report.cards.rewards_earned === 1 ? "" : "s"} earned and {report.cards.rewards_redeemed} redeemed here
              </li>
            </ul>
            {owner ? <HandBackForm shopId={shopId} current={shop.externalBookingUrl ?? ""} /> : <div className="text-zinc-600">An owner hands a shop back.</div>}
          </div>
        </Card>
      )}
    </div>
  );
}

function SectionView({ title, s }: { title: string; s: CutoverSection }) {
  const rows = [...s.differences.map((d) => ({ ...d, fix: true })), ...s.explained.map((d) => ({ ...d, fix: false }))];
  return (
    <div className="rounded-lg ring-1 ring-zinc-200">
      <div className="flex items-center justify-between border-b border-zinc-100 px-3 py-2 text-sm">
        <span className="font-medium">{title}</span>
        <Badge tone={s.differences.length ? "red" : "green"}>{s.differences.length ? `${s.differences.length} to fix` : "Matches"}</Badge>
      </div>
      <dl className="grid grid-cols-2 gap-2 px-3 py-2 text-sm">
        <div>
          <dt className="text-zinc-500">Squire</dt>
          <dd className="tabular">
            {s.expected.count} · {$(s.expected.cents)}
          </dd>
        </div>
        <div>
          <dt className="text-zinc-500">Here</dt>
          <dd className="tabular">
            {s.actual.count} · {$(s.actual.cents)}
          </dd>
        </div>
      </dl>
      {rows.length > 0 && (
        <Table>
          <thead>
            <tr>
              <Th>What</Th>
              <Th right>Squire</Th>
              <Th right>Here</Th>
              <Th> </Th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 200).map((d, i) => (
              <tr key={`${d.ref}-${i}`}>
                <Td>{d.label}</Td>
                <Td right>{$(d.squireCents)}</Td>
                <Td right>{$(d.hereCents)}</Td>
                <Td>{d.fix ? <Badge tone="red">Fix</Badge> : <Badge>Explained</Badge>}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}
