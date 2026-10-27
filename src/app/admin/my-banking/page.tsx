import type { Metadata } from "next";
import Link from "next/link";
import { and, inArray, ne } from "drizzle-orm";
import { db } from "@/db";
import { shops } from "@/db/schema";
import { Badge, Card, CardHeader, Empty, Notice, PageHeader, Table, Td, Th } from "@/components/ui";
import { BANKING_STATUS_LABEL, BANKING_STATUS_TONE, BankingStatus, PayoutDestination, destinationLabel, requirementLabels } from "@/domain/banking";
import { DEFAULT_INSTANT_FEE, METHOD_LABEL, TipMethod, effectiveMethod, parseInstantFee } from "@/domain/tips";
import { formatCents } from "@/lib/money";
import { formatDateTime } from "@/lib/time";
import { workShopIds } from "@/server/auth/access";
import { guardPage } from "@/server/auth/staff";
import { connectMode } from "@/server/payments/connect";
import { accountDestination, bankingActivity, externalAccountsView, refreshStaffAccount, staffAccount, staffAccountState } from "@/server/tips/accounts";
import { shopTipConfigs } from "@/server/tips/ledger";
import { tipOverrides } from "@/server/compensation";
import { PayoutChoice, StripeSetup } from "./client";

export const metadata: Metadata = { title: "My banking" };

const EXPLAIN: Record<BankingStatus, string> = {
  not_set_up: "Add your own debit card or bank account on Stripe's secure page to have your tips paid by Stripe.",
  pending_verification: "Stripe has your details and is checking them. That usually takes minutes, sometimes a day or two. Your tips keep adding up and are paid once it's done.",
  ready: "Stripe can pay your tips to the account below.",
  action_needed: "Stripe needs more information before it can keep paying you. Your tips aren't lost: they wait until it's sorted.",
};

type Activity = Awaited<ReturnType<typeof bankingActivity>>[number];

function activityText(a: Activity): string {
  const d = (a.details ?? {}) as Record<string, unknown>;
  switch (a.action) {
    case "tips.account_created":
      return "Payout account opened on Stripe";
    case "tips.onboarding_started":
      return "Opened Stripe's setup page";
    case "tips.onboarding_resumed":
      return "Opened Stripe's page to add what it asked for";
    case "tips.onboarding_simulated":
      return "Setup finished (simulator)";
    case "tips.account_state":
      return `Status changed from ${BANKING_STATUS_LABEL[d.from as BankingStatus] ?? d.from} to ${BANKING_STATUS_LABEL[d.to as BankingStatus] ?? d.to}`;
    case "tips.destination_changed": {
      const from = d.from as PayoutDestination | null;
      const to = d.to as PayoutDestination | null;
      return !to ? `Payout account removed (${destinationLabel(from)})` : from ? `Payout account changed from ${destinationLabel(from)} to ${destinationLabel(to)}` : `Payout account set to ${destinationLabel(to)}`;
    }
    case "tips.method": {
      const m = d.method as TipMethod | null;
      return `Payout method set to ${m ? METHOD_LABEL[m] : "the shop's default"}${d.instant ? " (instant)" : ""}`;
    }
    default:
      return a.action;
  }
}

export default async function MyBankingPage({ searchParams }: { searchParams: Promise<{ stripe?: string }> }) {
  const sp = await searchParams;
  const ctx = await guardPage("/admin/my-banking");
  if (ctx.staff.kind !== "person") return <Empty title="Shop logins don't earn tips">Sign in as yourself to set up your payouts.</Empty>;
  const me = ctx.staff.id;
  const assigned = await workShopIds(me);
  const shopRows = assigned.length ? await db.select({ id: shops.id, name: shops.name }).from(shops).where(and(inArray(shops.id, assigned), ne(shops.status, "archived"))) : [];
  if (!shopRows.length) return <Empty title="You aren't on a shop's team yet">Ask a manager to add you to a shop.</Empty>;
  if (sp.stripe) await refreshStaffAccount(me).catch(() => null);
  const [{ policy, policyOf, byShop }, acct, activity, planned] = await Promise.all([shopTipConfigs(shopRows.map((s) => s.id)), staffAccount(me), bankingActivity(me), tipOverrides([me])]);
  const status = staffAccountState(acct);
  const dest = accountDestination(acct);
  const accounts = externalAccountsView(acct);
  const fast = accounts.find((x) => x.instantDestination) ?? null;
  const simulator = connectMode() === "simulator";
  const rate = parseInstantFee(process.env.TIP_INSTANT_FEE) ?? DEFAULT_INSTANT_FEE;
  const methods = shopRows.map((s) => ({ shop: s.name, method: effectiveMethod(byShop.get(s.id)!, policyOf(s.id), acct?.method ?? null, planned.get(me)?.method) }));
  const paidByStripe = methods.some((m) => m.method === "stripe");
  const needs = requirementLabels(acct?.requirementsDue ?? []);
  const checking = requirementLabels(acct?.requirementsPending ?? []);
  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <PageHeader
        title="My banking"
        subtitle="Where your tips are paid. Stripe holds your bank, card, identity and tax details; this app never sees or stores them."
        actions={
          <Link className="text-sm text-brand-700 hover:underline" href="/admin/my-tips">
            My tips
          </Link>
        }
      />
      {sp.stripe === "return" && status !== "ready" && <Notice>{status === "pending_verification" ? "Thanks. Stripe is checking your details now." : "Stripe still needs a few details before it can pay you."}</Notice>}
      {sp.stripe === "refresh" && <Notice>Stripe&rsquo;s page expired. Open it again below.</Notice>}
      {policy.methods.includes("stripe") ? (
        <Card>
          <CardHeader title="Stripe payout account" subtitle="Your own debit card or bank account, set up and changed on Stripe's secure pages." />
          <div className="space-y-4 p-4 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={BANKING_STATUS_TONE[status]}>{BANKING_STATUS_LABEL[status]}</Badge>
              {acct?.simulated && <Badge tone="violet">Simulator</Badge>}
              {!paidByStripe && status === "not_set_up" && <span className="text-zinc-500">Only needed if you&rsquo;re paid by Stripe.</span>}
            </div>
            <p className="text-zinc-700">{EXPLAIN[status]}</p>
            {status === "action_needed" && acct?.payoutsEnabled && (
              <p className="text-zinc-600">Stripe can still pay you{acct.requirementsDeadline ? ` until ${formatDateTime(acct.requirementsDeadline)}` : " for now"}.</p>
            )}
            {status !== "not_set_up" && (
              <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-[10rem_1fr]">
                <dt className="text-zinc-500">Paid to</dt>
                <dd className="font-medium">{dest ? destinationLabel(dest) : "No card or bank yet"}</dd>
                <dt className="text-zinc-500">Instant payouts</dt>
                <dd>{fast ? `To ${fast.label}` : acct?.instantEligible ? "Available" : "Not available (needs an eligible debit card)"}</dd>
                {accounts.length > 1 && (
                  <>
                    <dt className="text-zinc-500">On your Stripe account</dt>
                    <dd>{accounts.map((x) => `${x.label}${x.default ? " (default)" : ""}`).join(", ")}</dd>
                  </>
                )}
              </dl>
            )}
            {needs.length > 0 && (
              <div className="rounded-md bg-amber-50 p-3 text-amber-900 ring-1 ring-inset ring-amber-200">
                <div className="font-medium">Stripe needs{acct?.requirementsDeadline ? ` by ${formatDateTime(acct.requirementsDeadline)}` : ""}:</div>
                <ul className="mt-1 list-disc pl-5">
                  {needs.map((n) => (
                    <li key={n}>{n}</li>
                  ))}
                </ul>
              </div>
            )}
            {checking.length > 0 && (
              <p className="text-zinc-600">
                Stripe is checking: {checking.join(", ")}.
              </p>
            )}
            <StripeSetup status={status} simulator={simulator} hasDestination={!!dest} />
          </div>
        </Card>
      ) : (
        <Notice tone="blue">Your tips aren&rsquo;t paid through Stripe, so there&rsquo;s no bank account to set up here.</Notice>
      )}
      <Card>
        <CardHeader title="How you're paid" subtitle={policy.employeeChooses ? "Pick how you'd like your tips paid. The brand sets which methods are allowed." : "The brand sets how tips are paid at each shop."} />
        <div className="space-y-3 p-4 text-sm">
          <ul className="space-y-1">
            {methods.map((m) => (
              <li key={m.shop} className="flex justify-between gap-2">
                <span className="text-zinc-600">{m.shop}</span>
                <span className="text-right">{METHOD_LABEL[m.method]}</span>
              </li>
            ))}
          </ul>
          {policy.employeeChooses && (
            <PayoutChoice
              methods={policy.methods}
              method={acct?.method ?? null}
              instant={!!acct?.instant}
              instantAllowed={policy.instantAllowed}
              instantEligible={!!acct?.instantEligible}
              feeText={`${rate.pct}%${rate.minCents ? `, at least ${formatCents(rate.minCents)}` : ""}`}
              feePassedOn={policy.instantFeePassedOn}
            />
          )}
        </div>
      </Card>
      <Card>
        <CardHeader title="Recent activity" subtitle="Any change to where or how you're paid sends you a security notice by email and text." />
        {activity.length ? (
          <Table>
            <thead>
              <tr>
                <Th>When</Th>
                <Th>What</Th>
                <Th>By</Th>
              </tr>
            </thead>
            <tbody>
              {activity.map((a, i) => (
                <tr key={i}>
                  <Td className="whitespace-nowrap">{formatDateTime(a.at)}</Td>
                  <Td>{activityText(a)}</Td>
                  <Td>{a.actorStaffId === me ? "You" : a.actor === "stripe" ? "Stripe" : (a.actor ?? "").slice((a.actor ?? "").indexOf(":") + 1)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <p className="px-4 py-6 text-sm text-zinc-500">Nothing yet.</p>
        )}
      </Card>
      <p className="text-xs text-zinc-500">
        What this app keeps: your Stripe account ID, its status, the type of account, the bank or card name and the last 4 digits. Managers see only the status and the last 4. Your full account and card numbers, Social Security number and ID stay with Stripe.
      </p>
      <p className="text-xs text-zinc-500">
        Tax forms: tips are wages, so they&rsquo;re reported on your W-2 through payroll and you won&rsquo;t get a 1099 for them. If Stripe ever needs your tax details it asks on its own page, never here.
      </p>
    </div>
  );
}
