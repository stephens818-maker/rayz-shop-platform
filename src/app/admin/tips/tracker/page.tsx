import type { Metadata } from "next";
import { asc, inArray } from "drizzle-orm";
import { db } from "@/db";
import { shops } from "@/db/schema";
import { Badge, Card, CardHeader, Empty, Notice, PageHeader, Select, Stat, Table, Td, Th, buttonClass } from "@/components/ui";
import { destinationLabel } from "@/domain/banking";
import { ACCOUNT_STATES, ACCOUNT_STATE_HINT, ACCOUNT_STATE_LABEL, ACCOUNT_STATE_TONE, TAX_FORMS_LABEL, heldLabel } from "@/domain/staff-payouts";
import { METHOD_LABEL, STATUS_LABEL } from "@/domain/tips";
import { formatCents } from "@/lib/money";
import { formatDate, formatDateTime } from "@/lib/time";
import { can, guardPage, reportShopIds } from "@/server/auth/staff";
import { directPayoutsAvailable } from "@/server/payments/money-movement";
import { tipToBarberShops } from "@/server/payments/settlement";
import { chainShopIds, payoutTracker, taxCheckView } from "@/server/tips/tracker";
import { PAYOUT_STATUS_TONE } from "../labels";
import { RecordTaxCheck, RefreshAccount } from "./client";

export const metadata: Metadata = { title: "Payout tracker" };

const MONTH = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export default async function PayoutTrackerPage({ searchParams }: { searchParams: Promise<{ shop?: string; state?: string }> }) {
  const ctx = await guardPage("/admin/tips/tracker");
  const sp = await searchParams;
  const chain = can(ctx, "payouts.chain");
  const manage = can(ctx, "payouts.manage");
  const visible = chain ? await chainShopIds() : ctx.shopIds;
  const shopIds = sp.shop && sp.shop !== "all" ? (visible.includes(sp.shop) ? [sp.shop] : []) : chain ? visible : reportShopIds(ctx, sp.shop ?? (ctx.currentShopId ? ctx.currentShopId : "all"));
  if (!shopIds.length) return <Empty title="No shop selected" />;
  const brandLevel = chain || ctx.brandWide;
  const [t, names, tax, on] = await Promise.all([
    payoutTracker(shopIds),
    db.select({ id: shops.id, name: shops.name }).from(shops).where(inArray(shops.id, visible)).orderBy(asc(shops.name)),
    brandLevel ? taxCheckView() : null,
    tipToBarberShops(shopIds),
  ]);
  const state = ACCOUNT_STATES.find((s) => s === sp.state) ?? null;
  const people = state ? t.people.filter((p) => p.state === state) : t.people;
  const label = shopIds.length === 1 ? (names.find((n) => n.id === shopIds[0])?.name ?? "This shop") : shopIds.length === visible.length ? (chain ? "The whole chain" : "All my shops") : `${shopIds.length} shops`;
  const direct = directPayoutsAvailable();
  const switchedOff = direct ? names.filter((n) => shopIds.includes(n.id) && !on.has(n.id)).map((n) => n.name) : [];
  const checked = tax?.checks.find((c) => c.taxYear === tax.taxYear) ?? null;
  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <PageHeader title="Payout tracker" subtitle={`${label}. Each barber's Stripe payout account, their payouts and what's owed. Stripe holds every bank and card number; only the last 4 is here.`} />
      <form method="get" className="flex flex-wrap items-end gap-2">
        <label className="text-sm text-zinc-700">
          <span className="mb-1 block text-xs font-medium text-zinc-500">Shop</span>
          <Select name="shop" defaultValue={shopIds.length === 1 ? shopIds[0] : "all"} className="w-72">
            {visible.length > 1 && <option value="all">{chain ? "The whole chain" : "All my shops"}</option>}
            {names.map((n) => (
              <option key={n.id} value={n.id}>
                {n.name}
              </option>
            ))}
          </Select>
        </label>
        <label className="text-sm text-zinc-700">
          <span className="mb-1 block text-xs font-medium text-zinc-500">Account status</span>
          <Select name="state" defaultValue={state ?? ""} className="w-56">
            <option value="">Every status</option>
            {ACCOUNT_STATES.map((s) => (
              <option key={s} value={s}>
                {ACCOUNT_STATE_LABEL[s]} ({t.counts[s]})
              </option>
            ))}
          </Select>
        </label>
        <button type="submit" className={buttonClass("secondary")}>
          Show
        </button>
      </form>
      {!direct && (
        <Notice tone="amber">
          Direct Stripe payouts aren&rsquo;t turned on yet, so approved Stripe payouts are held as owed. Where the brand sends owed tips to payroll (Tip payout settings), they&rsquo;re paid with the
          paycheck at the period&rsquo;s cutoff, never twice.
        </Notice>
      )}
      {switchedOff.length > 0 && (
        <Notice tone="amber">
          Tips to barbers&rsquo; Stripe accounts are turned off at {switchedOff.join(", ")} (Tip payout settings). Card tips there stay with the shop and are paid with the paycheck.
        </Notice>
      )}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-7">
        {ACCOUNT_STATES.map((s) => (
          <Stat key={s} label={ACCOUNT_STATE_LABEL[s]} value={String(t.counts[s])} tone={(s === "restricted" || s === "rejected") && t.counts[s] ? "down" : undefined} />
        ))}
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <Stat label="Owed" value={formatCents(t.owed.cents)} hint={`${t.owed.payouts} held payout${t.owed.payouts === 1 ? "" : "s"}: ${formatCents(t.owed.setupCents)} waiting on setup, ${formatCents(t.owed.transfersCents)} waiting to be transferred`} />
        <Stat label="Sent, not paid yet" value={formatCents(t.inFlightCents)} />
        <Stat label="Payouts (60 days)" value={String(t.payouts.length)} />
      </div>
      <Card>
        <CardHeader title="Accounts" subtitle="One Stripe recipient account per barber, set up in the staff app (or Stripe's page). Statuses come from Stripe's Connect webhooks." />
        {people.length ? (
          <Table label="Barbers' payout accounts">
            <thead>
              <tr>
                <Th>Barber</Th>
                <Th>Shops</Th>
                <Th>Status</Th>
                <Th>Paid to</Th>
                <Th>Stripe account</Th>
                {manage && <Th right />}
              </tr>
            </thead>
            <tbody>
              {people.map((p) => (
                <tr key={p.staffId}>
                  <Td>{p.name}</Td>
                  <Td>{p.shops.map((s) => s.name).join(", ")}</Td>
                  <Td>
                    <Badge tone={ACCOUNT_STATE_TONE[p.state]}>{ACCOUNT_STATE_LABEL[p.state]}</Badge>
                    {p.simulated && (
                      <Badge tone="violet" className="ml-1">
                        Simulator
                      </Badge>
                    )}
                    <span className="block text-xs text-zinc-500">
                      {ACCOUNT_STATE_HINT[p.state]}
                      {p.stateChangedAt ? ` Since ${formatDate(p.stateChangedAt, "MMM d")}.` : ""}
                    </span>
                    {p.needs.length > 0 && (
                      <span className="block text-xs text-amber-700">
                        Needs {p.needs.join(", ")}
                        {p.deadline ? ` by ${formatDateTime(p.deadline)}` : ""}
                      </span>
                    )}
                  </Td>
                  <Td>{p.last4 && p.destinationType ? destinationLabel({ type: p.destinationType, last4: p.last4, name: null }) : "—"}</Td>
                  <Td className="font-mono text-xs">{p.stripeAccountId ?? "—"}</Td>
                  {manage && <Td right>{p.stripeAccountId && !p.simulated && <RefreshAccount staffId={p.staffId} />}</Td>}
                </tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <p className="px-4 py-6 text-sm text-zinc-500">No one {state ? `is ${ACCOUNT_STATE_LABEL[state].toLowerCase()}` : "on the team here yet"}.</p>
        )}
      </Card>
      <Card>
        <CardHeader title="Payouts" subtitle="The last 60 days, newest first." />
        {t.payouts.length ? (
          <Table label="Tip payouts">
            <thead>
              <tr>
                <Th>Created</Th>
                <Th>Barber</Th>
                <Th>Shop</Th>
                <Th>How</Th>
                <Th>Status</Th>
                <Th right>Amount</Th>
              </tr>
            </thead>
            <tbody>
              {t.payouts.map((p) => (
                <tr key={p.id}>
                  <Td>{formatDate(p.createdAt, "MMM d")}</Td>
                  <Td>{p.name}</Td>
                  <Td>{p.shop}</Td>
                  <Td>
                    {METHOD_LABEL[p.method as keyof typeof METHOD_LABEL] ?? p.method}
                    {p.instant ? " · instant" : ""}
                  </Td>
                  <Td>
                    <Badge tone={PAYOUT_STATUS_TONE[p.status]}>{heldLabel(p) ?? STATUS_LABEL[p.status]}</Badge>
                    {p.failureMessage && <span className="block text-xs text-red-600">{p.failureMessage}</span>}
                  </Td>
                  <Td right>{formatCents(p.netCents)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <p className="px-4 py-6 text-sm text-zinc-500">No payouts in the last 60 days.</p>
        )}
      </Card>
      {tax && (
        <Card>
          <CardHeader
            title="Tax forms: yearly check"
            subtitle={`${TAX_FORMS_LABEL[tax.setting]}. Every ${MONTH[tax.month - 1]}, before Stripe files, check the barbers' accounts are set not to file and record it here.`}
            action={
              // A CSV download (route handler), not a page.
              // eslint-disable-next-line @next/next/no-html-link-for-pages
              <a className={buttonClass("secondary")} href="/admin/tips/onboarding/tax-forms">
                Download 1099 exclusions
              </a>
            }
          />
          <div className="space-y-3 px-4 py-3 text-sm">
            {tax.due ? (
              <Notice tone="amber">
                The {tax.taxYear} check is due: import the exclusions in the Stripe Dashboard (Tax reporting → Import → each 1099 form type → Update), then record it.
              </Notice>
            ) : checked ? (
              <Notice tone="green">
                {tax.taxYear} checked {formatDateTime(checked.checkedAt)}
                {checked.by ? ` by ${checked.by}` : ""}: {checked.accounts} account{checked.accounts === 1 ? "" : "s"}.
              </Notice>
            ) : (
              <p className="text-zinc-600">
                The {tax.taxYear} check opens in {MONTH[tax.month - 1]}.
              </p>
            )}
            {tax.status.feesOnAccount > 0 && (
              <Notice tone="red">
                {tax.status.feesOnAccount} account{tax.status.feesOnAccount === 1 ? " pays" : "s pay"} its own Stripe fees, so Stripe would send a 1099-K. Ask Stripe support to move the fees to Ray&apos;z.
              </Notice>
            )}
            <p className="text-zinc-600">
              {tax.status.accounts} barber Stripe account{tax.status.accounts === 1 ? "" : "s"}
              {tax.status.untagged ? `, ${tax.status.untagged} waiting for Stripe to confirm the W-2 tag` : ""}.
            </p>
            {manage && <RecordTaxCheck taxYear={tax.taxYear} recorded={!!checked} />}
            {tax.checks.length > 0 && (
              <ul className="space-y-1 text-xs text-zinc-500">
                {tax.checks.map((c) => (
                  <li key={c.id}>
                    {c.taxYear}: {c.accounts} accounts, {c.untagged} untagged, checked {formatDate(c.checkedAt, "MMM d, yyyy")}
                    {c.by ? ` by ${c.by}` : ""}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>
      )}
    </div>
  );
}
