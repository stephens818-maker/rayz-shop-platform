import type { Metadata } from "next";
import Link from "next/link";
import { Badge, Card, CardHeader, Empty, Notice, PageHeader } from "@/components/ui";
import { accountState, PAYMENTS_MODE_SHORT } from "@/domain/connect";
import { ENTITY_KIND_LABEL, ENTITY_STATUS_LABEL, FEE_COLLECTION_LABEL, bpsLabel, entityTaxSettings } from "@/domain/franchise";
import { formatDate } from "@/lib/time";
import { can, guardPage } from "@/server/auth/staff";
import { franchiseOverview, loadFranchiseData } from "@/server/franchise-admin";
import { canReachEntity } from "@/server/hierarchy";
import { refreshEntityAccount } from "@/server/payments/connect";
import { AccountStateBadge } from "../setup/panels";
import { EntityAccountPanel, EntityEditor, EntitySettingsForm, FeeTermsForm, FranchiseDataForm, RegionEditor, ShopMover, StandardsForm } from "./panels";

export const metadata: Metadata = { title: "Franchise & owner groups" };

export default async function FranchisePage({ searchParams }: { searchParams: Promise<{ entity?: string; stripe?: string }> }) {
  const ctx = await guardPage("/admin/franchise");
  const { entity: focus, stripe } = await searchParams;
  if (focus && stripe === "return" && canReachEntity(ctx, focus)) await refreshEntityAccount(focus).catch(() => null);
  const [o, settings] = await Promise.all([franchiseOverview(ctx), loadFranchiseData()]);
  const manage = can(ctx, "entities.manage");
  const banking = can(ctx, "entity.banking") || can(ctx, "payments.banking");
  const owners = o.entities.filter((e) => e.status !== "exited").map((e) => ({ id: e.id, name: e.name }));

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <PageHeader
        title="Franchise & owner groups"
        subtitle="Brand > owner group (Rayz corporate or a franchisee, each a legal business) > region (optional) > location. Each owner group has its own Stripe account, payroll company code, tax settings and reports."
        actions={manage && <EntityEditor entity={null} />}
      />
      {stripe === "return" && <Notice tone="blue">Stripe has what was entered. Anything it still needs is listed on the owner group below.</Notice>}

      {o.entities.length === 0 && <Empty title="No owner groups you can see" />}
      {o.entities.map((e) => {
        const reach = canReachEntity(ctx, e.id);
        const tax = entityTaxSettings(e.taxSettings);
        return (
          <Card key={e.id} id={`entity-${e.id}`} className={focus === e.id ? "ring-2 ring-brand-600" : undefined}>
            <CardHeader
              title={
                <span className="flex flex-wrap items-center gap-2">
                  {e.name}
                  <Badge tone={e.kind === "brand" ? "blue" : "violet"}>{ENTITY_KIND_LABEL[e.kind]}</Badge>
                  {e.status !== "active" && <Badge tone={e.status === "exited" ? "gray" : "amber"}>{ENTITY_STATUS_LABEL[e.status]}</Badge>}
                </span>
              }
              subtitle={[e.legalName, e.contactEmail, e.payrollCompanyCode && `Payroll company ${e.payrollCompanyCode}`].filter(Boolean).join(" · ") || undefined}
              action={manage && <EntityEditor entity={{ id: e.id, name: e.name, legalName: e.legalName, kind: e.kind, contactEmail: e.contactEmail, payrollCompanyCode: e.payrollCompanyCode, status: e.status }} />}
            />
            <div className="grid gap-4 p-4 text-sm md:grid-cols-2">
              <section className="space-y-2">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Locations</h3>
                {e.shops.length === 0 && <p className="text-zinc-500">No locations{reach ? " yet" : " you can see"}.</p>}
                <ul className="space-y-1.5">
                  {e.shops.map((s) => (
                    <li key={s.id} className="flex flex-wrap items-center justify-between gap-2">
                      <span>
                        <Link href={`/admin/setup?shop=${s.id}`} className="font-medium text-zinc-900 hover:underline">
                          {s.name}
                        </Link>
                        <span className="ml-2 text-xs text-zinc-500">
                          {PAYMENTS_MODE_SHORT[s.paymentsMode]}
                          {s.regionId && ` · ${o.regions.find((r) => r.id === s.regionId)?.name ?? ""}`}
                        </span>
                      </span>
                      {manage && <ShopMover shopId={s.id} ownerEntityId={e.id} regionId={s.regionId} owners={owners} regions={o.regions.map((r) => ({ id: r.id, name: r.name, ownerEntityId: r.ownerEntityId }))} />}
                    </li>
                  ))}
                </ul>
              </section>
              {reach && (
                <section className="space-y-2">
                  <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">
                    Stripe account <AccountStateBadge state={accountState(e.account)} />
                  </h3>
                  <p className="text-zinc-600">
                    Locations in &ldquo;owner group&rsquo;s account&rdquo; mode settle here. The legal entity, EIN, owners and bank are entered on Stripe&apos;s own pages and stay with Stripe.
                  </p>
                  {e.account?.requirementsDue.length ? <p className="text-amber-700">Stripe still needs: {e.account.requirementsDue.join(", ")}</p> : null}
                  {banking && <EntityAccountPanel entityId={e.id} started={!!e.account} enabled={accountState(e.account) === "enabled"} />}
                </section>
              )}
              {reach && (
                <section className="space-y-2">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Royalty and ad fund</h3>
                  {e.kind === "brand" ? (
                    <p className="text-zinc-500">Rayz corporate&apos;s own locations don&apos;t pay royalties.</p>
                  ) : (
                    <>
                      <p>
                        {e.currentTerms
                          ? `${bpsLabel(e.currentTerms.royaltyBps)} royalty and ${bpsLabel(e.currentTerms.adFundBps)} ad fund since ${formatDate(e.currentTerms.effectiveFrom, "MMM d, yyyy")}. ${FEE_COLLECTION_LABEL[e.currentTerms.collect]}.`
                          : "No rates yet: nothing is taken from card charges."}
                      </p>
                      {e.scheduledTerms.map((t) => (
                        <p key={t.id} className="text-zinc-500">
                          From {formatDate(t.effectiveFrom, "MMM d, yyyy")}: {bpsLabel(t.royaltyBps)} royalty, {bpsLabel(t.adFundBps)} ad fund ({FEE_COLLECTION_LABEL[t.collect].toLowerCase()})
                        </p>
                      ))}
                      {manage && <FeeTermsForm entityId={e.id} />}
                    </>
                  )}
                </section>
              )}
              {reach && can(ctx, "entity.settings") && (
                <section className="space-y-2">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Payroll and tax</h3>
                  <EntitySettingsForm entityId={e.id} contactEmail={e.contactEmail} payrollCompanyCode={e.payrollCompanyCode} filer={tax.filer} frequency={tax.frequency} />
                </section>
              )}
            </div>
          </Card>
        );
      })}

      <Card>
        <CardHeader
          title="Regions and markets"
          subtitle="Optional. A brand market can hold any owner group's locations (for reporting and regional managers); an owner group's region holds only its own."
          action={manage && <RegionEditor region={null} owners={owners} />}
        />
        <ul className="divide-y divide-zinc-100">
          {o.regions.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm">
              <div>
                <span className="font-medium text-zinc-900">{r.name}</span>
                <span className="ml-2 text-xs text-zinc-500">
                  {r.ownerEntityId ? `${o.entities.find((e) => e.id === r.ownerEntityId)?.name ?? "Owner group"}'s region` : "Brand market"} · {r.shops.map((s) => s.name).join(", ") || "no locations"}
                </span>
              </div>
              {manage && <RegionEditor region={{ id: r.id, name: r.name, ownerEntityId: r.ownerEntityId }} owners={owners} />}
            </li>
          ))}
          {o.regions.length === 0 && <li className="px-4 py-6 text-center text-sm text-zinc-500">No regions yet.</li>}
        </ul>
      </Card>

      {manage && (
        <Card>
          <CardHeader
            title="Client data and franchise agreements"
            subtitle="Every client profile is one brand-wide record held by the brand. These settings decide what franchisees may do with it; which ones an agreement calls for is for the brand's franchise attorney (see the README)."
          />
          <FranchiseDataForm initial={settings.data} />
        </Card>
      )}

      {can(ctx, "standards.manage") && (
        <Card>
          <CardHeader
            title="Brand standards"
            subtitle="What locations may change. People with access to every shop aren't held to these; franchisees and location managers are. Catalog prices are governed per item on Services and Products (brand price, floor and ceiling)."
          />
          <StandardsForm initial={settings.standards} />
        </Card>
      )}
    </div>
  );
}
