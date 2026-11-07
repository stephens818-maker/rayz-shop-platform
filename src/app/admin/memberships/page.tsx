import type { Metadata } from "next";
import Link from "next/link";
import { asc, eq } from "drizzle-orm";
import { Badge, Card, CardHeader, Empty, Notice, PageHeader, Select, Stat, Table, Td, Th, buttonClass } from "@/components/ui";
import { db } from "@/db";
import { services } from "@/db/schema";
import { MEMBERSHIP_STATUS_LABEL, planSummary } from "@/domain/memberships";
import { formatCents } from "@/lib/money";
import { formatDate, formatDateTime } from "@/lib/time";
import { can, guardPage, openShops } from "@/server/auth/staff";
import { stripe } from "@/server/payments/processor";
import { listPlans, membershipBoard, membershipsEnabled } from "@/server/memberships";
import { EnrollForm, MemberActions, MembershipsSwitch, PlanEditor, PlanRow } from "./editors";
import { clientPolicy } from "@/server/client-privacy";

export const metadata: Metadata = { title: "Memberships" };

const FILTERS = { live: "Current members", active: "Active", past_due: "Payment failed", incomplete: "Waiting for first payment", canceled: "Canceled", all: "Everyone" } as const;
const TONE = { active: "green", past_due: "red", incomplete: "amber", canceled: "gray" } as const;

export default async function MembershipsPage({ searchParams }: { searchParams: Promise<{ status?: string; plan?: string }> }) {
  const ctx = await guardPage("/admin/memberships");
  const sp = await searchParams;
  const filter = (sp.status && sp.status in FILTERS ? sp.status : "live") as keyof typeof FILTERS;
  const manage = can(ctx, "memberships.manage");
  const sell = can(ctx, "memberships.sell");
  const [on, plans] = await Promise.all([membershipsEnabled(ctx.currentShopId), listPlans()]);
  const planId = plans.some((p) => p.id === sp.plan) ? sp.plan : undefined;
  const policy = await clientPolicy(ctx);
  const board = await membershipBoard({ brandWide: ctx.brandWide, shopIds: ctx.shopIds, name: policy.name }, { status: filter === "live" ? undefined : filter, planId });
  const svc = manage ? await db.select({ id: services.id, name: services.name }).from(services).where(eq(services.active, true)).orderBy(asc(services.sortOrder), asc(services.name)) : [];
  const working = openShops(ctx).map((s) => ({ id: s.id, name: s.name }));
  const shopName = new Map(working.map((s) => [s.id, s.name]));
  const billedByStripe = !!stripe();
  const s = board.stats;

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <PageHeader
        title="Memberships"
        subtitle="Monthly plans like an unlimited buzz cut. Members pay through Stripe Billing, and checkout covers their plan's services automatically at every shop that honors the plan."
        actions={manage && ctx.brandWide ? <MembershipsSwitch on={on} /> : undefined}
      />
      {!on && (
        <Notice tone="amber">
          Memberships are off for the brand. Checkout won&apos;t cover visits and nobody can be signed up{manage ? " until you turn them on" : ""}. Plans and members are kept.
        </Notice>
      )}
      {!billedByStripe && (
        <Notice tone="blue">Stripe isn&apos;t connected here, so billing is simulated: sign-ups start right away and renew every month with a recorded payment.</Notice>
      )}

      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Active members" value={s.active} hint={s.ending ? `${s.ending} ending at month end` : undefined} />
        <Stat label="Monthly recurring" value={formatCents(s.mrr)} hint="Members who renew next month" />
        <Stat label="Covered visits, 30 days" value={s.visits} hint={`${formatCents(s.value)} of services`} />
        <Stat label="Payment failed" value={s.pastDue} tone={s.pastDue ? "down" : undefined} />
        <Stat label="Waiting to pay" value={s.incomplete} />
        <Stat label="Canceled, 30 days" value={s.canceled30} />
      </div>

      <Card>
        <CardHeader title="Plans" subtitle="Brand-wide. Each plan lists what a visit covers in full and which shops sell and honor it." />
        {plans.length === 0 ? (
          <Empty title="No plans yet">{manage ? "Add one below, for example Buzz Club: unlimited buzz cuts for $39 a month." : "Ask the brand owner to add a plan."}</Empty>
        ) : (
          <div className="divide-y divide-zinc-100">
            {plans.map((p) => {
              const body = (
                <>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-zinc-900">{p.name}</span>
                    <span className="tabular-nums text-zinc-700">{formatCents(p.priceCents)}/mo</span>
                    {!p.active && <Badge>Closed to sign-ups</Badge>}
                    {p.stripePriceId && <Badge tone="violet">Stripe Billing</Badge>}
                  </div>
                  <div className="text-sm text-zinc-600">{planSummary(p, p.serviceNames) || "Nothing covered yet"}</div>
                  <div className="text-xs text-zinc-500">{p.shopIds.length ? `Only at ${p.shopIds.map((id) => shopName.get(id) ?? "another shop").join(", ")}` : "Every shop"}</div>
                </>
              );
              return manage ? (
                <PlanRow key={p.id} plan={{ ...p, description: p.description ?? "" }} services={svc} shops={working}>
                  {body}
                </PlanRow>
              ) : (
                <div key={p.id} className="px-4 py-3">
                  {body}
                </div>
              );
            })}
          </div>
        )}
        {manage && (
          <div className="border-t border-zinc-100">
            <div className="px-4 pt-3 text-sm font-medium text-zinc-900">Add a plan</div>
            <PlanEditor plan={null} services={svc} shops={working} />
          </div>
        )}
      </Card>

      {sell && on && working.length > 0 && (
        <Card>
          <CardHeader title="Sign someone up" subtitle={billedByStripe ? "The client pays the first month on Stripe's secure page, at the counter or from a texted link. Their saved card then renews monthly." : "Starts today and renews monthly."} />
          <EnrollForm plans={plans.filter((p) => p.active)} shops={working} defaultShopId={ctx.currentShopId ?? null} />
        </Card>
      )}

      <Card>
        <CardHeader
          title={FILTERS[filter]}
          subtitle={ctx.brandWide ? "Members at every shop, by home shop." : "Members whose home shop is one of yours."}
          action={
            <form method="get" className="flex items-center gap-2">
              <Select name="status" defaultValue={filter} className="w-48">
                {Object.entries(FILTERS).map(([k, label]) => (
                  <option key={k} value={k}>
                    {label}
                  </option>
                ))}
              </Select>
              <Select name="plan" defaultValue={planId ?? ""} className="w-40">
                <option value="">Every plan</option>
                {plans.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
              <button type="submit" className={buttonClass("secondary", "sm")}>
                Show
              </button>
            </form>
          }
        />
        {board.members.length === 0 ? (
          <Empty title="No members here" />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Client</Th>
                <Th>Plan</Th>
                <Th>Home shop</Th>
                <Th>Status</Th>
                <Th right>Price</Th>
                <Th>This month</Th>
                <Th>Renews</Th>
                <Th>Since</Th>
                {sell && <Th />}
              </tr>
            </thead>
            <tbody>
              {board.members.map((m) => (
                <tr key={m.id}>
                  <Td>
                    <Link className="underline" href={`/admin/customers/${m.customerId}`}>
                      {m.client}
                    </Link>
                  </Td>
                  <Td>{m.plan}</Td>
                  <Td>{m.shop}</Td>
                  <Td>
                    <div className="flex flex-col items-start gap-1">
                      <Badge tone={TONE[m.status]}>{MEMBERSHIP_STATUS_LABEL[m.status]}</Badge>
                      {m.cancelAtPeriodEnd && <span className="text-xs text-amber-700">Ends {formatDate(m.periodEnd)}</span>}
                      {m.cancelReason && <span className="max-w-48 truncate text-xs text-zinc-500" title={m.cancelReason}>{m.cancelReason}</span>}
                      {m.checkoutUrl && (
                        <a className="text-xs underline" href={m.checkoutUrl} target="_blank" rel="noreferrer">
                          Payment link
                        </a>
                      )}
                    </div>
                  </Td>
                  <Td right>{formatCents(m.priceCents)}</Td>
                  <Td className="tabular-nums">{m.visitsPerPeriod == null ? `${m.used} visit${m.used === 1 ? "" : "s"}` : `${m.used} of ${m.visitsPerPeriod}`}</Td>
                  <Td className="text-xs">{m.status === "canceled" || m.cancelAtPeriodEnd ? "—" : formatDate(m.periodEnd)}</Td>
                  <Td className="text-xs">{formatDate(m.createdAt)}</Td>
                  {sell && (
                    <Td>
                      <MemberActions id={m.id} status={m.status} cancelAtPeriodEnd={m.cancelAtPeriodEnd} />
                    </Td>
                  )}
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Card>
        <CardHeader title="Recent payments" subtitle={billedByStripe ? "Monthly invoices from Stripe Billing. Failed payments retry on Stripe's schedule." : "Simulated monthly payments."} />
        {board.invoices.length === 0 ? (
          <Empty title="No payments yet" />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>When</Th>
                <Th>Client</Th>
                <Th>Plan</Th>
                <Th>Month</Th>
                <Th>Result</Th>
                <Th right>Amount</Th>
              </tr>
            </thead>
            <tbody>
              {board.invoices.map((i) => (
                <tr key={i.id}>
                  <Td className="text-xs">{formatDateTime(i.createdAt)}</Td>
                  <Td>{i.client}</Td>
                  <Td>{i.plan}</Td>
                  <Td className="text-xs">
                    {formatDate(i.periodStart)} – {formatDate(i.periodEnd)}
                  </Td>
                  <Td>{i.status === "paid" ? <Badge tone="green">Paid</Badge> : <Badge tone="red">{i.failureMessage ?? "Failed"}</Badge>}</Td>
                  <Td right>{formatCents(i.amountCents)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}
