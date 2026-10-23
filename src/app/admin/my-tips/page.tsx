import type { Metadata } from "next";
import { and, inArray, ne } from "drizzle-orm";
import { db } from "@/db";
import { shops } from "@/db/schema";
import { Badge, Card, CardHeader, Empty, Notice, PageHeader, Stat, Table, Td, Th } from "@/components/ui";
import { DEFAULT_INSTANT_FEE, ENTRY_STATUS_LABEL, METHOD_LABEL, STATUS_LABEL, effectiveMethod, entryStatus, parseInstantFee } from "@/domain/tips";
import { formatCents } from "@/lib/money";
import { formatDate, formatDateTime, todayLocal } from "@/lib/time";
import { workShopIds } from "@/server/auth/access";
import { guardPage } from "@/server/auth/staff";
import { connectMode } from "@/server/payments/connect";
import { STAFF_ACCOUNT_STATE_LABEL, refreshStaffAccount, staffAccount, staffAccountState } from "@/server/tips/accounts";
import { myTips } from "@/server/tips/ledger";
import { PAYOUT_STATUS_TONE } from "../tips/labels";
import { PayoutChoice, StripeSetup } from "./client";

export const metadata: Metadata = { title: "My tips" };

const KIND_LABEL: Record<string, string> = { tip: "Tip", refund: "Refunded", adjust: "Adjustment" };
const METHOD: Record<string, string> = { card: "Card", cash: "Cash", gift_card: "Gift card", adjust: "Manager" };
const STATUS_TONE = { pending_settlement: "gray", available: "blue", in_batch: "amber", paid_out: "green" } as const;

export default async function MyTipsPage({ searchParams }: { searchParams: Promise<{ stripe?: string }> }) {
  const sp = await searchParams;
  const ctx = await guardPage("/admin/my-tips");
  if (ctx.staff.kind !== "person") return <Empty title="Shop logins don't earn tips">Sign in as yourself to see your tips.</Empty>;
  const me = ctx.staff.id;
  const assigned = await workShopIds(me);
  const shopRows = assigned.length ? await db.select({ id: shops.id, name: shops.name }).from(shops).where(and(inArray(shops.id, assigned), ne(shops.status, "archived"))) : [];
  if (!shopRows.length) return <Empty title="You aren't on a shop's team yet">Ask a manager to add you to a shop.</Empty>;
  if (sp.stripe === "return") await refreshStaffAccount(me).catch(() => null);
  const today = todayLocal();
  const [t, acct] = await Promise.all([myTips(me, shopRows.map((s) => s.id), today), staffAccount(me)]);
  const shopName = new Map(shopRows.map((s) => [s.id, s.name]));
  const settingsOf = new Map(t.perShop.map((s) => [s.shopId, s.settings]));
  const state = staffAccountState(acct);
  const rate = parseInstantFee(process.env.TIP_INSTANT_FEE) ?? DEFAULT_INSTANT_FEE;
  const methods = t.perShop.map((s) => ({ shop: shopName.get(s.shopId) ?? "", method: effectiveMethod(s.settings, t.policy, acct?.method ?? null), schedule: s.settings.schedule }));
  const wantsStripe = t.policy.methods.includes("stripe") && (acct?.method === "stripe" || methods.some((m) => m.method === "stripe"));
  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <PageHeader title="My tips" subtitle="Your tips at each shop: today, waiting for card settlement, ready for the next payout, and paid out." />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat label="Tips today" value={formatCents(t.total.todayCents)} />
        <Stat label="Pending settlement" value={formatCents(t.total.pendingSettlementCents)} hint="card tips still settling" />
        <Stat label="Ready for payout" value={formatCents(t.total.availableCents)} hint="goes in the next batch" />
        <Stat label="In a payout" value={formatCents(t.total.inPayoutCents)} hint="being approved or sent" />
        <Stat label="Paid out" value={formatCents(t.total.paidOutCents)} />
      </div>
      {sp.stripe === "return" && state !== "ready" && <Notice>Stripe still needs a few details before it can pay you. Finish setup below.</Notice>}
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader title="How you're paid" subtitle={t.policy.employeeChooses ? "Pick how you'd like your tips paid. The brand sets which methods are allowed." : "The brand sets how tips are paid at each shop."} />
          <div className="space-y-3 p-4 text-sm">
            <ul className="space-y-1">
              {(methods.length ? methods : shopRows.map((s) => ({ shop: s.name, method: null, schedule: null }))).map((m) => (
                <li key={m.shop} className="flex justify-between gap-2">
                  <span className="text-zinc-600">{m.shop}</span>
                  <span className="text-right">{m.method ? METHOD_LABEL[m.method] : "No tips yet"}</span>
                </li>
              ))}
            </ul>
            {t.policy.employeeChooses && (
              <PayoutChoice
                methods={t.policy.methods}
                method={acct?.method ?? null}
                instant={!!acct?.instant}
                instantAllowed={t.policy.instantAllowed}
                instantEligible={!!acct?.instantEligible}
                feeText={`${rate.pct}%${rate.minCents ? `, at least ${formatCents(rate.minCents)}` : ""}`}
              />
            )}
          </div>
        </Card>
        {t.policy.methods.includes("stripe") && (
          <Card>
            <CardHeader title="Stripe payouts" subtitle="Your own debit card or bank account, set up on Stripe's page. This app never sees or stores your bank details." />
            <div className="space-y-3 p-4 text-sm">
              <div className="flex items-center gap-2">
                <Badge tone={state === "ready" ? "green" : state === "none" ? "gray" : "amber"}>{STAFF_ACCOUNT_STATE_LABEL[state]}</Badge>
                {acct?.simulated && <Badge tone="violet">Simulator</Badge>}
              </div>
              {acct?.requirementsDue?.length ? <p className="text-amber-700">Stripe needs: {acct.requirementsDue.join(", ").replace(/_/g, " ")}</p> : null}
              {!wantsStripe && state === "none" && <p className="text-zinc-600">Only needed if you&rsquo;re paid by Stripe.</p>}
              <StripeSetup state={state} simulator={connectMode() === "simulator"} />
            </div>
          </Card>
        )}
      </div>
      <Card>
        <CardHeader title="Payouts" />
        {t.payouts.filter((p) => p.method !== "prior").length ? (
          <Table>
            <thead>
              <tr>
                <Th>Date</Th>
                <Th>Shop</Th>
                <Th>Method</Th>
                <Th>Status</Th>
                <Th right>Tips</Th>
                <Th right>Fees</Th>
                <Th right>You got</Th>
              </tr>
            </thead>
            <tbody>
              {t.payouts
                .filter((p) => p.method !== "prior" && p.status !== "cancelled")
                .map((p) => (
                  <tr key={p.id}>
                    <Td>{formatDateTime(p.paidAt ?? p.sentAt ?? p.createdAt)}</Td>
                    <Td>{shopName.get(p.shopId)}</Td>
                    <Td>
                      {METHOD_LABEL[p.method]}
                      {p.instant ? " (instant)" : ""}
                    </Td>
                    <Td>
                      <Badge tone={PAYOUT_STATUS_TONE[p.status]}>{STATUS_LABEL[p.status]}</Badge>
                      {p.failureMessage && <span className="ml-2 text-xs text-red-600">{p.failureMessage}</span>}
                    </Td>
                    <Td right>{formatCents(p.grossCents + p.adjustCents)}</Td>
                    <Td right>{p.feeCents + p.instantFeeCents ? formatCents(-(p.feeCents + p.instantFeeCents)) : ""}</Td>
                    <Td right className="font-medium">
                      {formatCents(p.netCents - p.instantFeeCents)}
                    </Td>
                  </tr>
                ))}
            </tbody>
          </Table>
        ) : (
          <p className="px-4 py-6 text-sm text-zinc-500">No payouts yet.</p>
        )}
      </Card>
      <Card>
        <CardHeader title="Tip history" subtitle="The last 60 days, by ticket. Card tips are paid once their card money has settled." />
        {t.recent.length ? (
          <Table>
            <thead>
              <tr>
                <Th>Date</Th>
                <Th>Shop</Th>
                <Th>Ticket</Th>
                <Th>Kind</Th>
                <Th right>Amount</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {t.recent.map((e) => {
                const st = entryStatus(e, settingsOf.get(e.shopId)!, today);
                return (
                  <tr key={e.id}>
                    <Td>{formatDate(e.businessDate, "EEE MMM d")}</Td>
                    <Td>{shopName.get(e.shopId)}</Td>
                    <Td>{e.saleNumber ? `#${e.saleNumber}` : "—"}</Td>
                    <Td>
                      {KIND_LABEL[e.kind]} · {METHOD[e.method]}
                      {e.reason ? <span className="block text-xs text-zinc-500">{e.reason}</span> : null}
                    </Td>
                    <Td right className={e.amountCents < 0 ? "text-red-600" : ""}>
                      {formatCents(e.amountCents)}
                    </Td>
                    <Td>
                      <Badge tone={STATUS_TONE[st]}>{e.payoutMethod === "prior" ? "Paid before tip payouts" : ENTRY_STATUS_LABEL[st]}</Badge>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        ) : (
          <p className="px-4 py-6 text-sm text-zinc-500">No tips in the last 60 days.</p>
        )}
      </Card>
    </div>
  );
}
