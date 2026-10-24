"use client";

import { useState } from "react";
import { Button, Field, Input, Select } from "@/components/ui";
import { useAction } from "@/components/use-action";
import { CONTENT_POLICIES, SHOP_NUMBER_POLICIES, SHOP_TOGGLE_POLICIES, type BrandStandards, type ContentPolicy, type ShopNumberPolicy, type ShopTogglePolicy } from "@/domain/brand-standards";
import { ENTITY_KIND_LABEL, ENTITY_STATUS_LABEL, FEE_COLLECTION_LABEL, FRANCHISE_DATA_LABEL, type FeeCollection, type FranchiseData, type OwnerEntityKind, type OwnerEntityStatus } from "@/domain/franchise";
import {
  addFeeTermsAction,
  deleteRegionAction,
  entityDashboardAction,
  moveShopAction,
  refreshEntityAccountAction,
  saveEntityAction,
  saveEntitySettingsAction,
  saveFranchiseDataAction,
  saveRegionAction,
  saveStandardsAction,
  startEntityOnboardingAction,
} from "./actions";

function Problem({ error }: { error: string | null }) {
  return error ? (
    <p role="alert" className="text-sm text-red-600">
      {error}
    </p>
  ) : null;
}

type EntityValues = { id: string; name: string; legalName: string | null; kind: OwnerEntityKind; contactEmail: string | null; payrollCompanyCode: string | null; status: OwnerEntityStatus };

export function EntityEditor({ entity }: { entity: EntityValues | null }) {
  const { pending, error, run } = useAction();
  const [open, setOpen] = useState(false);
  const [v, setV] = useState({
    name: entity?.name ?? "",
    legalName: entity?.legalName ?? "",
    kind: entity?.kind ?? ("franchisee" as OwnerEntityKind),
    contactEmail: entity?.contactEmail ?? "",
    payrollCompanyCode: entity?.payrollCompanyCode ?? "",
    status: entity?.status ?? ("onboarding" as OwnerEntityStatus),
  });
  if (!open)
    return (
      <Button size="sm" variant={entity ? "ghost" : "primary"} onClick={() => setOpen(true)}>
        {entity ? "Edit" : "Add an owner group"}
      </Button>
    );
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV({ ...v, [k]: e.target.value });
  return (
    <div className="w-full max-w-md space-y-2 rounded-lg bg-zinc-50 p-3 text-left">
      <Field label="Name">
        <Input value={v.name} onChange={set("name")} placeholder="e.g. Northside Cuts LLC" />
      </Field>
      <Field label="Legal name" hint="As registered; Stripe verifies it with the EIN.">
        <Input value={v.legalName} onChange={set("legalName")} />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Kind">
          <Select value={v.kind} onChange={set("kind")}>
            {(Object.keys(ENTITY_KIND_LABEL) as OwnerEntityKind[]).map((k) => (
              <option key={k} value={k}>
                {ENTITY_KIND_LABEL[k]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Status">
          <Select value={v.status} onChange={set("status")}>
            {(Object.keys(ENTITY_STATUS_LABEL) as OwnerEntityStatus[]).map((k) => (
              <option key={k} value={k}>
                {ENTITY_STATUS_LABEL[k]}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Field label="Contact email">
        <Input type="email" value={v.contactEmail} onChange={set("contactEmail")} />
      </Field>
      <Field label="Payroll company code" hint="The owner group's company code in iSolved.">
        <Input value={v.payrollCompanyCode} onChange={set("payrollCompanyCode")} />
      </Field>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          disabled={pending}
          onClick={() =>
            run(
              () => saveEntityAction(entity?.id ?? null, { ...v, legalName: v.legalName || null, contactEmail: v.contactEmail || null, payrollCompanyCode: v.payrollCompanyCode || null }),
              () => setOpen(false),
            )
          }
        >
          {pending ? "Saving…" : "Save"}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
      <Problem error={error} />
    </div>
  );
}

export function EntityAccountPanel({ entityId, started, enabled }: { entityId: string; started: boolean; enabled: boolean }) {
  const { pending, error, run } = useAction();
  return (
    <div className="flex flex-wrap items-center gap-2">
      {!enabled && (
        <Button size="sm" disabled={pending} onClick={() => run(() => startEntityOnboardingAction(entityId), (d) => (window.location.href = d.url))}>
          {started ? "Continue Stripe onboarding" : "Set up Stripe account"}
        </Button>
      )}
      {started && (
        <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => refreshEntityAccountAction(entityId))}>
          Check status
        </Button>
      )}
      {enabled && (
        <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => entityDashboardAction(entityId), (d) => window.open(d.url, "_blank", "noopener"))}>
          Stripe dashboard
        </Button>
      )}
      <Problem error={error} />
    </div>
  );
}

export function FeeTermsForm({ entityId }: { entityId: string }) {
  const { pending, error, run } = useAction();
  const [open, setOpen] = useState(false);
  const [v, setV] = useState({ effectiveFrom: "", royaltyPct: "", adFundPct: "", collect: "application_fee" as FeeCollection });
  if (!open)
    return (
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        Change rates
      </Button>
    );
  return (
    <div className="space-y-2 rounded-lg bg-zinc-50 p-3">
      <div className="grid grid-cols-3 gap-2">
        <Field label="Starts">
          <Input type="date" value={v.effectiveFrom} onChange={(e) => setV({ ...v, effectiveFrom: e.target.value })} />
        </Field>
        <Field label="Royalty %">
          <Input inputMode="decimal" value={v.royaltyPct} onChange={(e) => setV({ ...v, royaltyPct: e.target.value })} placeholder="6" />
        </Field>
        <Field label="Ad fund %">
          <Input inputMode="decimal" value={v.adFundPct} onChange={(e) => setV({ ...v, adFundPct: e.target.value })} placeholder="2" />
        </Field>
      </div>
      <Field label="Collected" hint="Royalty-eligible sales: services and products after discounts, before tax, tips and gift card sales.">
        <Select value={v.collect} onChange={(e) => setV({ ...v, collect: e.target.value as FeeCollection })}>
          {(Object.keys(FEE_COLLECTION_LABEL) as FeeCollection[]).map((k) => (
            <option key={k} value={k}>
              {FEE_COLLECTION_LABEL[k]}
            </option>
          ))}
        </Select>
      </Field>
      <div className="flex items-center gap-2">
        <Button size="sm" disabled={pending} onClick={() => run(() => addFeeTermsAction(entityId, v), () => setOpen(false))}>
          {pending ? "Saving…" : "Save rates"}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
      <Problem error={error} />
    </div>
  );
}

export function EntitySettingsForm({
  entityId,
  contactEmail,
  payrollCompanyCode,
  filer,
  frequency,
}: {
  entityId: string;
  contactEmail: string | null;
  payrollCompanyCode: string | null;
  filer: "entity" | "brand";
  frequency: Record<string, string>;
}) {
  const { pending, error, run } = useAction();
  const [v, setV] = useState({
    contactEmail: contactEmail ?? "",
    payrollCompanyCode: payrollCompanyCode ?? "",
    filer,
    frequency: Object.entries(frequency)
      .map(([s, f]) => `${s}=${f}`)
      .join(", "),
  });
  const [saved, setSaved] = useState(false);
  const parseFrequency = () =>
    Object.fromEntries(
      v.frequency
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean)
        .map((p) => p.split("=").map((x) => x.trim()))
        .map(([s, f]) => [s.toUpperCase(), f?.toLowerCase()]),
    );
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <Field label="Contact email">
          <Input type="email" value={v.contactEmail} onChange={(e) => setV({ ...v, contactEmail: e.target.value })} />
        </Field>
        <Field label="Payroll company code">
          <Input value={v.payrollCompanyCode} onChange={(e) => setV({ ...v, payrollCompanyCode: e.target.value })} />
        </Field>
      </div>
      <Field label="Sales tax is filed by">
        <Select value={v.filer} onChange={(e) => setV({ ...v, filer: e.target.value as "entity" | "brand" })}>
          <option value="entity">This owner group</option>
          <option value="brand">The brand, on its behalf</option>
        </Select>
      </Field>
      <Field label="Filing frequency by state" hint="e.g. IL=monthly, IA=quarterly. Tax IDs stay with Stripe and the state, never here.">
        <Input value={v.frequency} onChange={(e) => setV({ ...v, frequency: e.target.value })} />
      </Field>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          disabled={pending}
          onClick={() =>
            run(
              () =>
                saveEntitySettingsAction(entityId, {
                  contactEmail: v.contactEmail || null,
                  payrollCompanyCode: v.payrollCompanyCode || null,
                  taxSettings: { filer: v.filer, frequency: parseFrequency() },
                }),
              () => setSaved(true),
            )
          }
        >
          {pending ? "Saving…" : "Save"}
        </Button>
        {saved && !pending && <span className="text-xs text-emerald-700">Saved</span>}
      </div>
      <Problem error={error} />
    </div>
  );
}

type RegionOption = { id: string; name: string; ownerEntityId: string | null };

export function ShopMover({ shopId, ownerEntityId, regionId, owners, regions }: { shopId: string; ownerEntityId: string; regionId: string | null; owners: { id: string; name: string }[]; regions: RegionOption[] }) {
  const { pending, error, run } = useAction();
  const [open, setOpen] = useState(false);
  const [owner, setOwner] = useState(ownerEntityId);
  const [region, setRegion] = useState(regionId ?? "");
  const [notes, setNotes] = useState<string[]>([]);
  const fits = regions.filter((r) => !r.ownerEntityId || r.ownerEntityId === owner);
  if (!open)
    return (
      <span className="flex flex-col items-end">
        <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
          Move
        </Button>
        {notes.map((n) => (
          <span key={n} className="max-w-xs text-right text-xs text-amber-700">
            {n}
          </span>
        ))}
      </span>
    );
  return (
    <div className="flex w-full flex-wrap items-end gap-2 rounded-lg bg-zinc-50 p-2">
      <Field label="Owner group">
        <Select
          value={owner}
          onChange={(e) => {
            setOwner(e.target.value);
            if (!regions.some((r) => r.id === region && (!r.ownerEntityId || r.ownerEntityId === e.target.value))) setRegion("");
          }}
        >
          {owners.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Region">
        <Select value={region} onChange={(e) => setRegion(e.target.value)}>
          <option value="">None</option>
          {fits.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </Select>
      </Field>
      <Button
        size="sm"
        disabled={pending}
        onClick={() =>
          run(
            () => moveShopAction(shopId, owner, region || null),
            (d) => {
              setNotes(d.notes);
              setOpen(false);
            },
          )
        }
      >
        {pending ? "Moving…" : "Save"}
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
        Cancel
      </Button>
      <Problem error={error} />
    </div>
  );
}

export function RegionEditor({ region, owners }: { region: RegionOption | null; owners: { id: string; name: string }[] }) {
  const { pending, error, run } = useAction();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(region?.name ?? "");
  const [owner, setOwner] = useState(region?.ownerEntityId ?? "");
  if (!open)
    return (
      <Button size="sm" variant={region ? "ghost" : "primary"} onClick={() => setOpen(true)}>
        {region ? "Edit" : "Add a region"}
      </Button>
    );
  return (
    <div className="flex w-full flex-wrap items-end gap-2 rounded-lg bg-zinc-50 p-2">
      <Field label="Name">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Quad Cities" />
      </Field>
      <Field label="Belongs to">
        <Select value={owner} onChange={(e) => setOwner(e.target.value)}>
          <option value="">The brand (a market)</option>
          {owners.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </Select>
      </Field>
      <Button size="sm" disabled={pending} onClick={() => run(() => saveRegionAction(region?.id ?? null, { name, ownerEntityId: owner || null }), () => setOpen(false))}>
        {pending ? "Saving…" : "Save"}
      </Button>
      {region && (
        <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => deleteRegionAction(region.id), () => setOpen(false))}>
          Delete
        </Button>
      )}
      <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
        Cancel
      </Button>
      <Problem error={error} />
    </div>
  );
}

export function FranchiseDataForm({ initial }: { initial: FranchiseData }) {
  const { pending, error, run } = useAction();
  const [v, setV] = useState(initial);
  const [saved, setSaved] = useState(false);
  const choice = <K extends keyof typeof FRANCHISE_DATA_LABEL>(k: K, label: string) => (
    <Field label={label}>
      <Select value={v[k] as string} onChange={(e) => setV({ ...v, [k]: e.target.value })}>
        {Object.entries(FRANCHISE_DATA_LABEL[k]).map(([value, text]) => (
          <option key={value} value={value}>
            {text}
          </option>
        ))}
      </Select>
    </Field>
  );
  return (
    <div className="space-y-3 p-4">
      <div className="grid gap-3 md:grid-cols-2">
        {choice("clientOwnership", "Who owns client data under the agreement")}
        {choice("crossOwnerHistory", "Visit history franchisee staff see")}
        {choice("franchiseeExport", "Client contact exports by franchisees")}
        {choice("onExit", "When a franchisee leaves")}
      </div>
      <Field label="Agreement reference" hint="The agreement and section these follow, for the audit log.">
        <Input value={v.agreementRef ?? ""} onChange={(e) => setV({ ...v, agreementRef: e.target.value || null })} placeholder="e.g. FA 2026 §14.3" />
      </Field>
      <div className="flex items-center gap-2">
        <Button size="sm" disabled={pending} onClick={() => run(() => saveFranchiseDataAction(v), () => setSaved(true))}>
          {pending ? "Saving…" : "Save"}
        </Button>
        {saved && !pending && <span className="text-xs text-emerald-700">Saved</span>}
      </div>
      <Problem error={error} />
    </div>
  );
}

const num = (s: string) => (s.trim() === "" ? null : Number(s));

export function StandardsForm({ initial }: { initial: BrandStandards }) {
  const { pending, error, run } = useAction();
  const [v, setV] = useState(initial);
  const [saved, setSaved] = useState(false);
  const rule = (k: ShopNumberPolicy, patch: Partial<BrandStandards["shop"][ShopNumberPolicy]>) => setV({ ...v, shop: { ...v.shop, [k]: { ...v.shop[k], ...patch } } });
  return (
    <div className="space-y-4 p-4 text-sm">
      <table className="w-full">
        <thead>
          <tr className="text-left text-xs text-zinc-500">
            <th className="pb-1 font-medium">Shop setting</th>
            <th className="pb-1 font-medium">Locations may</th>
            <th className="pb-1 font-medium">Min</th>
            <th className="pb-1 font-medium">Max</th>
            <th className="pb-1 font-medium">Brand value</th>
          </tr>
        </thead>
        <tbody>
          {(Object.keys(SHOP_NUMBER_POLICIES) as ShopNumberPolicy[]).map((k) => {
            const r = v.shop[k];
            return (
              <tr key={k}>
                <td className="py-1 pr-2">
                  {SHOP_NUMBER_POLICIES[k].label} <span className="text-xs text-zinc-400">({SHOP_NUMBER_POLICIES[k].unit})</span>
                </td>
                <td className="py-1 pr-2">
                  <Select aria-label={`${SHOP_NUMBER_POLICIES[k].label}: rule`} value={r.mode} onChange={(e) => rule(k, { mode: e.target.value as typeof r.mode })}>
                    <option value="open">Change it</option>
                    <option value="range">Stay within limits</option>
                    <option value="locked">Not change it</option>
                  </Select>
                </td>
                <td className="py-1 pr-2">
                  <Input aria-label={`${SHOP_NUMBER_POLICIES[k].label}: minimum`} disabled={r.mode !== "range"} value={r.min ?? ""} onChange={(e) => rule(k, { min: num(e.target.value) })} />
                </td>
                <td className="py-1 pr-2">
                  <Input aria-label={`${SHOP_NUMBER_POLICIES[k].label}: maximum`} disabled={r.mode !== "range"} value={r.max ?? ""} onChange={(e) => rule(k, { max: num(e.target.value) })} />
                </td>
                <td className="py-1">
                  <Input aria-label={`${SHOP_NUMBER_POLICIES[k].label}: brand value`} disabled={r.mode !== "locked"} value={r.value ?? ""} onChange={(e) => rule(k, { value: num(e.target.value) })} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="grid gap-2 md:grid-cols-2">
        {(Object.keys(SHOP_TOGGLE_POLICIES) as ShopTogglePolicy[]).map((k) => (
          <Field key={k} label={SHOP_TOGGLE_POLICIES[k]}>
            <Select value={v.toggles[k]} onChange={(e) => setV({ ...v, toggles: { ...v.toggles, [k]: e.target.value as "local" | "brand" } })}>
              <option value="local">Each location sets it</option>
              <option value="brand">Set by the brand</option>
            </Select>
          </Field>
        ))}
        {(Object.keys(CONTENT_POLICIES) as ContentPolicy[]).map((k) => (
          <Field key={k} label={CONTENT_POLICIES[k]}>
            <Select value={v.content[k]} onChange={(e) => setV({ ...v, content: { ...v.content, [k]: e.target.value as "local" | "brand" } })}>
              <option value="brand">Brand only</option>
              <option value="local">Locations may add their own</option>
            </Select>
          </Field>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" disabled={pending} onClick={() => run(() => saveStandardsAction(v), () => setSaved(true))}>
          {pending ? "Saving…" : "Save standards"}
        </Button>
        {saved && !pending && <span className="text-xs text-emerald-700">Saved</span>}
      </div>
      <Problem error={error} />
    </div>
  );
}
