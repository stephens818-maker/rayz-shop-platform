import type { Metadata } from "next";
import Link from "next/link";
import { and, inArray, ne } from "drizzle-orm";
import { db } from "@/db";
import { shops } from "@/db/schema";
import { Badge, Card, CardHeader, Empty, PageHeader, Stat, Table, Td, Th } from "@/components/ui";
import { BANKING_STATUS_LABEL, BANKING_STATUS_TONE, destinationLabel } from "@/domain/banking";
import { ENTRY_STATUS_LABEL, METHOD_LABEL, STATUS_LABEL, effectiveMethod, employeeFeeCents, entryStatus, receivedCents } from "@/domain/tips";
import { formatCents } from "@/lib/money";
import { addDays, formatDate, formatDateTime, todayLocal } from "@/lib/time";
import { workShopIds } from "@/server/auth/access";
import { guardPage } from "@/server/auth/staff";
import { accountDestination, staffAccount, staffAccountState } from "@/server/tips/accounts";
import { myTips, shopTipConfigs } from "@/server/tips/ledger";
import { tipOverrides } from "@/server/compensation";
import { PAYOUT_STATUS_TONE } from "../tips/labels";

export const metadata: Metadata = { title: "My tips" };

const KIND_LABEL: Record<string, string> = { tip: "Tip", refund: "Refunded", adjust: "Adjustment" };
const METHOD: Record<string, string> = { card: "Card", cash: "Cash", gift_card: "Gift card", adjust: "Manager" };
const STATUS_TONE = { pending_settlement: "gray", available: "blue", in_batch: "amber", paid_out: "green" } as const;

export default async function MyTipsPage({ searchParams }: { searchParams: Promise<{ history?: string }> }) {
  const sp = await searchParams;
  const ctx = await guardPage("/admin/my-tips");
  if (ctx.staff.kind !== "person") return <Empty title="Shop logins don't earn tips">Sign in as yourself to see your tips.</Empty>;
  const me = ctx.staff.id;
  const assigned = await workShopIds(me);
  const shopRows = assigned.length ? await db.select({ id: shops.id, name: shops.name }).from(shops).where(and(inArray(shops.id, assigned), ne(shops.status, "archived"))) : [];
  if (!shopRows.length) return <Empty title="You aren't on a shop's team yet">Ask a manager to add you to a shop.</Empty>;
  const today = todayLocal();
  const [t, acct] = await Promise.all([myTips(me, shopRows.map((s) => s.id), today), staffAccount(me)]);
  const shopName = new Map(shopRows.map((s) => [s.id, s.name]));
  const settingsOf = new Map(t.perShop.map((s) => [s.shopId, s.settings]));
  const state = staffAccountState(acct);
  const [{ byShop }, planned] = await Promise.all([shopTipConfigs(shopRows.map((s) => s.id)), tipOverrides([me])]);
  const methods = shopRows.map((s) => ({ shop: s.name, method: effectiveMethod(byShop.get(s.id)!, t.policy, acct?.method ?? null, planned.get(me)?.method) }));
  const dest = accountDestination(acct);
  const longHistory = sp.history === "60";
  const history = longHistory ? t.recent : t.recent.filter((e) => e.businessDate >= addDays(today, -13));
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
      <Card>
        <CardHeader
          title="How you're paid"
          action={
            <Link className="text-sm text-brand-700 hover:underline" href="/admin/my-banking">
              {t.policy.employeeChooses ? "Change in My banking" : "My banking"}
            </Link>
          }
        />
        <div className="grid gap-4 p-4 text-sm md:grid-cols-2">
          <ul className="space-y-1">
            {methods.map((m) => (
              <li key={m.shop} className="flex justify-between gap-2">
                <span className="text-zinc-600">{m.shop}</span>
                <span className="text-right">
                  {METHOD_LABEL[m.method]}
                  {m.method === "stripe" && acct?.instant && acct.instantEligible && t.policy.instantAllowed ? " (instant)" : ""}
                </span>
              </li>
            ))}
          </ul>
          {t.policy.methods.includes("stripe") && (
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <span className="text-zinc-600">Stripe payout account</span>
                <Badge tone={BANKING_STATUS_TONE[state]}>{BANKING_STATUS_LABEL[state]}</Badge>
              </div>
              {dest && <div className="text-zinc-700">Paid to {destinationLabel(dest)}</div>}
              {wantsStripe && state !== "ready" && (
                <Link className="text-brand-700 hover:underline" href="/admin/my-banking">
                  {state === "not_set_up" ? "Set it up so Stripe can pay you" : state === "action_needed" ? "Stripe needs more information" : "See its status"}
                </Link>
              )}
            </div>
          )}
        </div>
      </Card>
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
                    <Td right>{p.feeCents + employeeFeeCents(p) ? formatCents(-(p.feeCents + employeeFeeCents(p))) : ""}</Td>
                    <Td right className="font-medium">
                      {formatCents(receivedCents(p))}
                      {p.destinationLast4 && <span className="block text-xs font-normal text-zinc-500">to ••{p.destinationLast4}</span>}
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
        <CardHeader
          title="Tip history"
          subtitle={`The last ${longHistory ? 60 : 14} days, by ticket. Card tips are paid once their card money has settled.`}
          action={
            <Link className="text-sm text-brand-700 hover:underline" href={longHistory ? "/admin/my-tips" : "/admin/my-tips?history=60"}>
              {longHistory ? "Last 14 days" : "Last 60 days"}
            </Link>
          }
        />
        {history.length ? (
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
              {history.map((e) => {
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
          <p className="px-4 py-6 text-sm text-zinc-500">No tips in the last {longHistory ? 60 : 14} days.</p>
        )}
      </Card>
    </div>
  );
}
