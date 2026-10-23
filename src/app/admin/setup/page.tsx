import type { Metadata } from "next";
import Link from "next/link";
import { Badge, Card, CardHeader, Empty, LinkButton, Notice, PageHeader, Table, Td, Th, cx } from "@/components/ui";
import { OWNER_KIND_LABEL, formatFeeRate } from "@/domain/connect";
import { SHOP_STATUS_LABEL } from "@/domain/location-lifecycle";
import { can, guardPage } from "@/server/auth/staff";
import { SETUP_ORDER, locationSetup, ownerEntityList, setupOverview } from "@/server/location-setup";
import { refreshAccount } from "@/server/payments/connect";
import { AccountStateBadge, LifecyclePanel, OwnerEditor, OwnerPicker, PaymentsPanel } from "./panels";

const STATUS_TONE = { setup: "amber", live: "green", closed: "blue", archived: "gray" } as const;

export const metadata: Metadata = { title: "Location setup" };

type Params = { shop?: string; step?: string; stripe?: string };

export default async function LocationSetupPage({ searchParams }: { searchParams: Promise<Params> }) {
  const ctx = await guardPage("/admin/setup");
  const { shop: requested, step, stripe } = await searchParams;
  const shopId = requested && ctx.shopIds.includes(requested) ? requested : null;
  if (!shopId) return <Overview shopIds={ctx.shopIds} canEditOwners={ctx.brandWide} canAdd={can(ctx, "locations.setup")} />;

  if (stripe === "return") await refreshAccount(shopId).catch(() => null);
  const [setup, owners] = await Promise.all([locationSetup(shopId), ownerEntityList()]);
  if (!setup) return <Empty title="That shop wasn't found" />;
  const { shop, owner, account, state, steps, blockers, mode, fees } = setup;
  const required = steps.filter((s) => s.required);
  const done = required.filter((s) => s.done).length;

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            {shop.status === "setup" ? `Set up ${shop.name}` : shop.name}
            <Badge tone={STATUS_TONE[shop.status]}>{SHOP_STATUS_LABEL[shop.status]}</Badge>
          </span>
        }
        subtitle={`${done} of ${required.length} required steps done${shop.status === "setup" ? " before go-live" : ""}. Each step saves as you go, so you can leave and come back.`}
        actions={
          <LinkButton variant="ghost" href="/admin/setup">
            All locations
          </LinkButton>
        }
      />
      <div
        className="h-1.5 overflow-hidden rounded-full bg-zinc-100"
        role="progressbar"
        aria-label="Setup progress"
        aria-valuemin={0}
        aria-valuemax={required.length}
        aria-valuenow={done}
      >
        <div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${(done / required.length) * 100}%` }} />
      </div>
      <LifecyclePanel
        shop={{ id: shop.id, name: shop.name, status: shop.status, closedUntil: shop.closedUntil, closedNote: shop.closedNote }}
        blockers={blockers.map((k) => steps.find((x) => x.key === k)?.title ?? k)}
        paymentsReady={state === "enabled"}
        canManage={can(ctx, "locations.setup")}
      />
      {stripe === "return" && state === "enabled" && (
        <Notice tone="green">{shop.name} can take cards. Its sales, tips, refunds and payouts now settle in its own Stripe account.</Notice>
      )}
      {stripe === "return" && state !== "enabled" && <Notice tone="blue">Stripe has what you entered. Anything it still needs is listed under Card payments.</Notice>}
      <ol className="space-y-3">
        {SETUP_ORDER.map((key, i) => {
          const s = steps.find((x) => x.key === key)!;
          const focus = step === key;
          return (
            <li key={key}>
              <Card id={`step-${key}`} className={cx(focus && "ring-2 ring-brand-600")}>
                <div className="flex items-start gap-3 px-4 py-3">
                  <span
                    aria-hidden
                    className={cx(
                      "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
                      s.done ? "bg-emerald-100 text-emerald-700" : "bg-zinc-100 text-zinc-500",
                    )}
                  >
                    {s.done ? "✓" : i + 1}
                  </span>
                  <div className="min-w-0 flex-1 space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h2 className="text-sm font-semibold text-zinc-900">
                        {s.title}
                        {!s.required && <span className="ml-2 text-xs font-normal text-zinc-400">Recommended</span>}
                        <span className="sr-only">{s.done ? " (done)" : " (to do)"}</span>
                      </h2>
                      {s.href && (
                        <Link href={s.href} className="text-sm font-medium text-brand-700 hover:underline">
                          {s.done ? "Change" : "Set up"}
                        </Link>
                      )}
                    </div>
                    {key === "owner" ? (
                      <p className="text-sm text-zinc-600">The shop&apos;s P&amp;L rolls up to its owner. A franchisee can own several shops.</p>
                    ) : (
                      <p className="text-sm text-zinc-600">{s.detail}</p>
                    )}
                    {key === "owner" && <OwnerPicker shopId={shop.id} ownerId={owner?.id ?? null} owners={owners.map((o) => ({ id: o.id, name: o.name, kind: o.kind }))} />}
                    {key === "payments" && (
                      <PaymentsPanel
                        shopId={shop.id}
                        shopName={shop.name}
                        state={state}
                        mode={mode}
                        account={
                          account && {
                            stripeAccountId: account.stripeAccountId,
                            simulated: account.simulated,
                            requirementsDue: account.requirementsDue,
                            disabledReason: account.disabledReason,
                            chargesEnabled: account.chargesEnabled,
                            payoutsEnabled: account.payoutsEnabled,
                          }
                        }
                        fees={{ keyed: formatFeeRate(fees.keyed), terminal: formatFeeRate(fees.terminal) }}
                        expired={stripe === "refresh"}
                      />
                    )}
                  </div>
                </div>
              </Card>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

async function Overview({ shopIds, canEditOwners, canAdd }: { shopIds: string[]; canEditOwners: boolean; canAdd: boolean }) {
  const [rows, owners] = await Promise.all([setupOverview(shopIds), ownerEntityList()]);
  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <PageHeader
        title="Location setup"
        subtitle="Every location and its go-live checklist: details, owner, hours, taxes, menu, team, its own Stripe account for card payments and payouts, and online booking."
        actions={canAdd && <LinkButton href="/admin/setup/new">Add a location</LinkButton>}
      />
      {rows.length === 0 ? (
        <Empty title="No locations yet">Add the first one with Add a location.</Empty>
      ) : (
        <Card>
          <Table>
            <thead>
              <tr>
                <Th>Location</Th>
                <Th>Status</Th>
                <Th>Owner</Th>
                <Th>Card payments</Th>
                <Th>Stripe account</Th>
                <Th right>Setup</Th>
                <Th>
                  <span className="sr-only">Open</span>
                </Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="hover:bg-zinc-50">
                  <Td className="font-medium text-zinc-900">{r.name}</Td>
                  <Td>
                    <Badge tone={STATUS_TONE[r.status]}>{SHOP_STATUS_LABEL[r.status]}</Badge>
                  </Td>
                  <Td>{r.ownerName ? `${r.ownerName}${r.ownerKind === "franchisee" ? " (franchisee)" : ""}` : <span className="text-zinc-400">Not set</span>}</Td>
                  <Td>
                    <AccountStateBadge state={r.state} />
                  </Td>
                  <Td>{r.stripeAccountId ? <code className="text-xs text-zinc-600">{r.stripeAccountId}</code> : <span className="text-zinc-400">None yet</span>}</Td>
                  <Td right>
                    {r.done}/{r.total}
                  </Td>
                  <Td right>
                    <Link href={`/admin/setup?shop=${r.id}`} className="font-medium text-brand-700 hover:underline">
                      {r.status === "archived" ? "View" : r.done === r.total ? "Review" : "Continue"}
                      <span className="sr-only"> setting up {r.name}</span>
                    </Link>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
      <Card>
        <CardHeader
          title="Owners"
          subtitle="Who owns each location's business. Shops are grouped by owner in the Shop P&L report, so a franchisee who owns several shops sees them together; each shop still has its own Stripe account."
          action={<OwnerEditor owner={null} canEdit={canEditOwners} />}
        />
        <ul className="divide-y divide-zinc-100">
          {owners.map((o) => (
            <li key={o.id} className="flex flex-wrap items-start justify-between gap-2 px-4 py-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2 text-sm font-medium text-zinc-900">
                  {o.name}
                  <Badge tone={o.kind === "brand" ? "blue" : "violet"}>{OWNER_KIND_LABEL[o.kind]}</Badge>
                </div>
                <div className="mt-0.5 text-sm text-zinc-500">
                  {[o.legalName, o.contactEmail].filter(Boolean).join(" · ")}
                  {(o.legalName || o.contactEmail) && " · "}
                  {o.shops.length ? o.shops.map((s) => s.name).join(", ") : "No shops yet"}
                </div>
              </div>
              <OwnerEditor owner={o} canEdit={canEditOwners} />
            </li>
          ))}
          {owners.length === 0 && <li className="px-4 py-6 text-center text-sm text-zinc-500">No owners yet.</li>}
        </ul>
      </Card>
    </div>
  );
}
