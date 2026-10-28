import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, Card, CardHeader, Notice, PageHeader, Table, Td, Th } from "@/components/ui";
import type { CutoverSection } from "@/db/schema";
import { ONBOARDING_LABEL } from "@/domain/staff-onboarding";
import { formatDate, formatDateTime, todayLocal } from "@/lib/time";
import { can, guardPage } from "@/server/auth/staff";
import { handBackReport, listCutovers, REQUIRED_FILES } from "@/server/cutover";
import { payoutCutoverReport, ytdImports } from "@/server/payout-cutover";
import { inTenant } from "@/server/tenant";
import { shopOnboardingCounts } from "@/server/tips/onboarding";
import { tipToBarberAt } from "@/server/payments/settlement";
import { stripePayoutsOn } from "@/server/tips/payout-model";
import { Importer } from "../../import/importer";
import { STAGE } from "../stages";
import { CpaSignOffForm, FreezeForm, HandBackForm, PayoutDatesForm, PayoutSignOffButton, ReconcileForm, SignOffButton, SquireTipsEndForm, YtdImportForm } from "./client";

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
  const stripe = stripePayoutsOn() && (await tipToBarberAt(shopId));
  const team = (await shopOnboardingCounts([shopId])).get(shopId)!;
  const allSet = !stripe || team.notDone.length === 0;
  const ends = c?.squireTipsEndOn ?? null;
  const year = Number(todayLocal().slice(0, 4));
  const [payout, ytd] = await Promise.all([payoutCutoverReport(shopId), ytdImports(shopId, year)]);

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

      {stripe ? (
      <Card>
        <CardHeader
          title="Staff payout onboarding: everyone set up before Squire's payouts stop"
          subtitle="No Squire Stripe account carries over: everyone sets up a new Stripe payout account under Ray'z. Squire stops paying this shop's tips when it moves here, so signing off needs everyone done, or an owner's reason to go ahead. Tips for anyone not done wait for them."
          action={<Badge tone={allSet ? "green" : "amber"}>{`${team.done} of ${team.total} set up`}</Badge>}
        />
        <div className="space-y-3 p-4 text-sm">
          {ends && (
            <div>
              Squire pays this shop&rsquo;s tips through <b>{formatDate(ends, "EEEE, MMM d")}</b>.
            </div>
          )}
          {allSet ? (
            <Notice tone="green">{team.total ? "Everyone on the team can be paid through Stripe." : "No one on the team yet."}</Notice>
          ) : (
            <ul className="list-disc pl-5 text-zinc-700">
              {team.notDone.slice(0, 30).map((p) => (
                <li key={p.staffId}>
                  {p.name}: {ONBOARDING_LABEL[p.progress]}
                </li>
              ))}
              {team.notDone.length > 30 && <li>and {team.notDone.length - 30} more</li>}
            </ul>
          )}
          {!allSet && can(ctx, "tips.approve") && (
            <Link className="inline-block underline" href={`/admin/tips/onboarding?shop=${shopId}`}>
              Invite or remind them in Payout onboarding
            </Link>
          )}
          <SquireTipsEndForm shopId={shopId} current={ends} />
        </div>
      </Card>
      ) : (
        <Card>
          <CardHeader
            title="Staff tips after the switch: through payroll"
            subtitle="Tips taken here are paid with each person's paycheck through iSolved, with withholding. Nobody sets up a payout account; direct deposit stays in iSolved. Squire pays what it owes for tips taken on Squire."
            action={<Badge tone="green">Payroll</Badge>}
          />
          <div className="space-y-3 p-4 text-sm">
            {ends && (
              <div>
                Squire pays this shop&rsquo;s tips through <b>{formatDate(ends, "EEEE, MMM d")}</b>.
              </div>
            )}
            <SquireTipsEndForm shopId={shopId} current={ends} />
          </div>
        </Card>
      )}

      <CutoverChecklist report={payout} />
      <PayoutReconciliation report={payout} canDates={can(ctx, "import.run") || can(ctx, "tips.approve")} canSign={can(ctx, "tips.approve")} canCpa={owner} />

      <Card>
        <CardHeader
          title={`${year} year to date from Squire`}
          subtitle="Each barber's tips and sales on Squire this year, so year totals in the staff app and the W-2 reconcile with iSolved. Read-only for staff. Have the CPA check them before year end."
        />
        <div className="space-y-3 p-4 text-sm">
          {ytd.length > 0 && (
            <Table>
              <thead>
                <tr>
                  <Th>Barber</Th>
                  <Th>Through</Th>
                  <Th right>Card tips</Th>
                  <Th right>Cash tips</Th>
                  <Th right>Service sales</Th>
                  <Th right>Product sales</Th>
                  <Th right>Paid out by Squire</Th>
                </tr>
              </thead>
              <tbody>
                {ytd.map((r) => (
                  <tr key={r.staffId}>
                    <Td>{r.name}</Td>
                    <Td>{formatDate(r.throughDate)}</Td>
                    <Td right>{$(r.cardTipsCents)}</Td>
                    <Td right>{$(r.cashTipsCents)}</Td>
                    <Td right>{$(r.serviceSalesCents)}</Td>
                    <Td right>{$(r.productSalesCents)}</Td>
                    <Td right>{$(r.paidOutCents)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
          {can(ctx, "import.run") && <YtdImportForm shopId={shopId} year={year} />}
        </div>
      </Card>

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
                  subtitle={`An owner signs off on the reconciliation above${stripe ? " and on staff payout onboarding" : ""}. Online booking for this shop then moves here: the website and app book it here, and the Squire link stops showing.`}
                />
                <div className="p-4">{owner ? <SignOffButton shopId={shopId} ready={stage === "reconciled"} notOnboarded={stripe ? team.notDone.length : 0} /> : <div className="text-sm text-zinc-600">An owner signs off and switches.</div>}</div>
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

function CutoverChecklist({ report: r }: { report: Awaited<ReturnType<typeof payoutCutoverReport>> }) {
  const done = r.checklist.filter((x) => x.done).length;
  return (
    <Card>
      <CardHeader
        title="Tips cutover checklist"
        subtitle="Squire stops at a Saturday close; every tip date has one owner; Squire's tickets, its final statement and the barbers agree; the manager and then the CPA sign."
        action={<Badge tone={done === r.checklist.length ? "green" : "amber"}>{`${done} of ${r.checklist.length} done`}</Badge>}
      />
      <ol className="space-y-2 p-4 text-sm">
        {r.checklist.map((x) => (
          <li key={x.key} className="flex gap-3">
            <Badge tone={x.done ? "green" : "gray"}>{x.done ? "Done" : "To do"}</Badge>
            <div>
              <div className="font-medium">{x.label}</div>
              <div className="text-zinc-600">{x.detail}</div>
            </div>
          </li>
        ))}
      </ol>
    </Card>
  );
}

function PayoutReconciliation({ report: r, canDates, canSign, canCpa }: { report: Awaited<ReturnType<typeof payoutCutoverReport>>; canDates: boolean; canSign: boolean; canCpa: boolean }) {
  return (
    <Card>
      <CardHeader
        title="Tip payouts: Squire to Ray'z"
        subtitle="What Squire still owes each barber (Squire tickets after its last payout statement, through the last day it pays this shop's tips), Squire's last payout day and the first Ray'z payout. Each barber confirms their line in the staff app; then the shop manager signs it off."
        action={r.signedOff ? <Badge tone={r.signedOff.current ? "green" : "amber"}>{r.signedOff.current ? "Signed off" : "Changed since sign-off"}</Badge> : undefined}
      />
      <div className="space-y-3 p-4 text-sm">
        {!r.squireTipsEndOn && <Notice tone="amber">Enter the last day Squire pays this shop&rsquo;s tips above first.</Notice>}
        <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <div>
            <dt className="text-zinc-500">Squire statement covers</dt>
            <dd>{r.squirePaidThrough ? `through ${formatDate(r.squirePaidThrough)}` : "—"}</dd>
          </div>
          <div>
            <dt className="text-zinc-500">Squire&rsquo;s last tips day</dt>
            <dd>{r.squireTipsEndOn ? formatDate(r.squireTipsEndOn) : "—"}</dd>
          </div>
          <div>
            <dt className="text-zinc-500">Squire&rsquo;s last payout</dt>
            <dd>{r.squireLastPayoutOn ? formatDate(r.squireLastPayoutOn) : "—"}</dd>
          </div>
          <div>
            <dt className="text-zinc-500">First Ray&rsquo;z payout</dt>
            <dd>{r.firstRayzPayout ? `${formatDate(r.firstRayzPayout.checkDate)} (${r.firstRayzPayout.via === "payroll" ? "paycheck" : "Stripe"}, tips from ${formatDate(r.firstRayzPayout.periodStart, "MMM d")})` : "—"}</dd>
          </div>
        </dl>
        {canDates && <PayoutDatesForm shopId={r.shopId} paidThrough={r.squirePaidThrough} lastPayoutOn={r.squireLastPayoutOn} statementCents={r.tieOut.statementCents} />}
        {r.lines.length > 0 && (
          <Table>
            <thead>
              <tr>
                <Th>Barber</Th>
                <Th right>Squire owes</Th>
                <Th right>Tickets</Th>
                <Th>Barber says</Th>
              </tr>
            </thead>
            <tbody>
              {r.lines.map((l) => (
                <tr key={l.staffId}>
                  <Td>{l.name}</Td>
                  <Td right>{$(l.squireOwedCents)}</Td>
                  <Td right>{l.tickets}</Td>
                  <Td>
                    {!l.confirmation?.current ? (
                      <span className="text-zinc-500">{l.confirmation ? "Amount changed; asked again" : "Waiting"}</span>
                    ) : l.confirmation.status === "confirmed" ? (
                      <Badge tone="green">Confirmed</Badge>
                    ) : (
                      <span>
                        <Badge tone="red">Disputed</Badge> <span className="text-xs text-zinc-600">{l.confirmation.note}</span>
                      </span>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        <div className="text-zinc-600">
          {$(r.totals.squireOwedCents)} owed by Squire in all. {r.totals.confirmed} confirmed, {r.totals.disputed} disputed, {r.totals.waiting} waiting.
          {r.signedOff && ` Signed off ${formatDateTime(r.signedOff.at)}${r.signedOff.by ? ` by ${r.signedOff.by}` : ""}.`}
        </div>
        {canSign && <PayoutSignOffButton shopId={r.shopId} ready={r.ready && !r.totals.disputed && !r.signedOff?.current} />}
        {r.cpa && (
          <div className="text-zinc-600">
            CPA: {r.cpa.name} signed {formatDate(r.cpa.signedOn)}
            {r.cpa.by ? `, recorded by ${r.cpa.by}` : ""}.{!r.cpa.current && " The report changed since; ask them to sign again."}
          </div>
        )}
        {canCpa && r.signedOff?.current && !r.cpa?.current && <CpaSignOffForm shopId={r.shopId} />}
      </div>
    </Card>
  );
}
