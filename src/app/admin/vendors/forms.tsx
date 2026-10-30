"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, Card, CardHeader, Field, Input, Select, Table, Td, Textarea, Th, cx } from "@/components/ui";
import { useAction } from "@/components/use-action";
import { removeVendorProductAction, saveVendorAction, saveVendorProductAction, setVendorActiveAction } from "./actions";

const $ = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const toCents = (s: string) => Math.round((Number(s.replace(/[^0-9.]/g, "")) || 0) * 100);

export interface VendorView {
  id: string | null;
  name: string;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  accountNumber: string | null;
  paymentTerms: string | null;
  leadTimeDays: number;
  minimumOrderCents: number;
  sendCsv: boolean;
  notes: string | null;
  active: boolean;
}

export const BLANK_VENDOR: VendorView = { id: null, name: "", contactName: null, email: null, phone: null, address: null, accountNumber: null, paymentTerms: "Net 30", leadTimeDays: 7, minimumOrderCents: 0, sendCsv: false, notes: null, active: true };

export function VendorForm({ vendor, editable, onDone }: { vendor: VendorView; editable: boolean; onDone?: () => void }) {
  const router = useRouter();
  const { pending, error, run } = useAction();
  const [f, setF] = useState(() => ({
    name: vendor.name,
    contactName: vendor.contactName ?? "",
    email: vendor.email ?? "",
    phone: vendor.phone ?? "",
    address: vendor.address ?? "",
    accountNumber: vendor.accountNumber ?? "",
    paymentTerms: vendor.paymentTerms ?? "",
    leadTimeDays: String(vendor.leadTimeDays),
    minimum: (vendor.minimumOrderCents / 100).toFixed(2),
    sendCsv: vendor.sendCsv,
    notes: vendor.notes ?? "",
  }));
  const [saved, setSaved] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => {
    setSaved(false);
    setF({ ...f, [k]: e.target.value });
  };
  const text = (k: keyof typeof f, label: string, o: { placeholder?: string; className?: string; type?: string } = {}) => (
    <Field label={label} className={o.className}>
      <Input value={f[k] as string} onChange={set(k)} disabled={!editable} placeholder={o.placeholder} type={o.type} />
    </Field>
  );
  return (
    <div className="space-y-3">
      <div className="grid gap-3 md:grid-cols-3">
        {text("name", "Vendor name", { className: "md:col-span-2" })}
        {text("accountNumber", "Our account number")}
        {text("contactName", "Contact person")}
        {text("email", "Order email", { type: "email", placeholder: "orders@vendor.com" })}
        {text("phone", "Phone")}
        <Field label="Address" className="md:col-span-3">
          <Textarea rows={2} value={f.address} onChange={set("address")} disabled={!editable} />
        </Field>
        {text("paymentTerms", "Payment terms", { placeholder: "Net 30" })}
        <Field label="Lead time (days)" hint="Sets the expected date on new orders">
          <Input inputMode="numeric" value={f.leadTimeDays} onChange={set("leadTimeDays")} disabled={!editable} />
        </Field>
        <Field label="Minimum order" hint="Orders below it get a warning">
          <Input inputMode="decimal" value={f.minimum} onChange={set("minimum")} disabled={!editable} />
        </Field>
        <Field label="Notes" className="md:col-span-3">
          <Textarea rows={2} value={f.notes} onChange={set("notes")} disabled={!editable} placeholder="Rep visits, cut-off times, free-shipping thresholds…" />
        </Field>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={f.sendCsv} disabled={!editable} onChange={(e) => setF({ ...f, sendCsv: e.target.checked })} />
        Attach a CSV with the PDF when emailing orders (for vendors who import them)
      </label>
      {editable && (
        <div className="flex items-center gap-3">
          <Button
            disabled={pending || !f.name.trim()}
            onClick={() =>
              run(
                () =>
                  saveVendorAction(vendor.id, {
                    name: f.name,
                    contactName: f.contactName,
                    email: f.email,
                    phone: f.phone,
                    address: f.address,
                    accountNumber: f.accountNumber,
                    paymentTerms: f.paymentTerms,
                    leadTimeDays: Math.floor(Number(f.leadTimeDays) || 0),
                    minimumOrderCents: toCents(f.minimum),
                    sendCsv: f.sendCsv,
                    notes: f.notes,
                  }),
                (r) => {
                  if (!vendor.id) router.push(`/admin/vendors/${r.id}`);
                  else setSaved(true);
                  onDone?.();
                },
              )
            }
          >
            {vendor.id ? "Save vendor" : "Add vendor"}
          </Button>
          {saved && <span className="text-sm text-green-700">Saved.</span>}
          {error && <span className="text-sm text-red-600">{error}</span>}
        </div>
      )}
    </div>
  );
}

export function NewVendor() {
  const [open, setOpen] = useState(false);
  if (!open) return <Button onClick={() => setOpen(true)}>Add vendor</Button>;
  return (
    <Card className="w-full">
      <CardHeader title="New vendor" action={<Button variant="ghost" size="sm" onClick={() => setOpen(false)}>Close</Button>} />
      <div className="p-4">
        <VendorForm vendor={BLANK_VENDOR} editable />
      </div>
    </Card>
  );
}

export function ActiveToggle({ id, active }: { id: string; active: boolean }) {
  const { pending, error, run } = useAction();
  return (
    <span className="flex items-center gap-2">
      <Button variant={active ? "secondary" : "primary"} disabled={pending} onClick={() => run(() => setVendorActiveAction(id, !active))}>
        {active ? "Mark inactive" : "Reactivate"}
      </Button>
      {error && <span className="text-sm text-red-600">{error}</span>}
    </span>
  );
}

interface Offer {
  productId: string;
  sku: string;
  name: string;
  active: boolean;
  vendorSku: string | null;
  casePack: number;
  costCents: number;
  preferred: boolean;
  /** Who else is preferred for this product, if not this vendor. */
  preferredElsewhere: string | null;
}

export function VendorProducts({ vendorId, offers, catalog, editable }: { vendorId: string; offers: Offer[]; catalog: { id: string; sku: string; name: string; costCents: number }[]; editable: boolean }) {
  const { pending, error, run } = useAction();
  const [edit, setEdit] = useState<Record<string, { vendorSku: string; casePack: string; cost: string; preferred: boolean }>>({});
  const [adding, setAdding] = useState("");
  const carried = new Set(offers.map((o) => o.productId));
  const draft = (o: Offer) => edit[o.productId] ?? { vendorSku: o.vendorSku ?? "", casePack: String(o.casePack), cost: (o.costCents / 100).toFixed(2), preferred: o.preferred };
  const dirty = (o: Offer) => {
    const d = draft(o);
    return d.vendorSku !== (o.vendorSku ?? "") || d.casePack !== String(o.casePack) || toCents(d.cost) !== o.costCents || d.preferred !== o.preferred;
  };
  const change = (o: Offer, patch: Partial<ReturnType<typeof draft>>) => setEdit({ ...edit, [o.productId]: { ...draft(o), ...patch } });
  const save = (o: Offer) => {
    const d = draft(o);
    run(
      () => saveVendorProductAction(vendorId, { productId: o.productId, vendorSku: d.vendorSku, casePack: Math.max(1, Math.floor(Number(d.casePack) || 1)), costCents: toCents(d.cost), preferred: d.preferred }),
      () => setEdit(({ [o.productId]: done, ...rest }) => rest),
    );
  };
  return (
    <Card>
      <CardHeader title="Products from this vendor" subtitle="Their SKU, case pack and cost. Suggested orders go to each product's preferred vendor, rounded up to whole cases." />
      <Table>
        <thead>
          <tr>
            <Th>Product</Th>
            <Th>Vendor SKU</Th>
            <Th right>Case pack</Th>
            <Th right>Cost</Th>
            <Th>Preferred</Th>
            {editable && <Th />}
          </tr>
        </thead>
        <tbody>
          {offers.map((o) => {
            const d = draft(o);
            return (
              <tr key={o.productId} className={cx(!o.active && "text-zinc-400")}>
                <Td>
                  <div className="font-medium">{o.name}</div>
                  <div className="text-xs text-zinc-500">
                    {o.sku}
                    {!o.active && " · discontinued"}
                  </div>
                </Td>
                <Td>{editable ? <Input className="w-32" value={d.vendorSku} onChange={(e) => change(o, { vendorSku: e.target.value })} /> : (o.vendorSku ?? "—")}</Td>
                <Td right>{editable ? <Input className="w-20 text-right" inputMode="numeric" value={d.casePack} onChange={(e) => change(o, { casePack: e.target.value })} /> : o.casePack}</Td>
                <Td right>{editable ? <Input className="w-24 text-right" inputMode="decimal" value={d.cost} onChange={(e) => change(o, { cost: e.target.value })} /> : $(o.costCents)}</Td>
                <Td>
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" disabled={!editable} checked={d.preferred} onChange={(e) => change(o, { preferred: e.target.checked })} />
                    {d.preferred ? "Preferred" : o.preferredElsewhere ? <span className="text-xs text-zinc-500">{o.preferredElsewhere} is preferred</span> : <span className="text-xs text-zinc-500">no preferred vendor</span>}
                  </label>
                </Td>
                {editable && (
                  <Td right className="whitespace-nowrap">
                    {dirty(o) ? (
                      <Button size="sm" disabled={pending} onClick={() => save(o)}>
                        Save
                      </Button>
                    ) : (
                      <button className="text-xs text-zinc-500 hover:text-red-600" disabled={pending} onClick={() => run(() => removeVendorProductAction(vendorId, o.productId))}>
                        Remove
                      </button>
                    )}
                  </Td>
                )}
              </tr>
            );
          })}
        </tbody>
      </Table>
      {editable && (
        <div className="flex flex-wrap items-end gap-3 border-t border-zinc-100 p-4">
          <Field label="Add a product" className="w-96">
            <Select value={adding} onChange={(e) => setAdding(e.target.value)}>
              <option value="">Choose…</option>
              {catalog
                .filter((p) => !carried.has(p.id))
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.sku})
                  </option>
                ))}
            </Select>
          </Field>
          <Button
            variant="secondary"
            disabled={pending || !adding}
            onClick={() => {
              const p = catalog.find((x) => x.id === adding)!;
              run(
                () => saveVendorProductAction(vendorId, { productId: p.id, vendorSku: null, casePack: 1, costCents: p.costCents, preferred: false }),
                () => setAdding(""),
              );
            }}
          >
            Add
          </Button>
          <span className="text-xs text-zinc-500">Starts at the catalog cost and a case of 1; set the vendor&apos;s SKU, case and price after.</span>
        </div>
      )}
      {error && <div className="px-4 pb-4 text-sm text-red-600">{error}</div>}
    </Card>
  );
}
