"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Chips, ItemPicker, toggle } from "@/components/chips";
import { Button, Field, Input, Notice, Select } from "@/components/ui";
import { CODE_MODES, CODE_MODE_LABEL, COUPON_TYPES, COUPON_TYPE_LABEL, DAY_NAMES, type CodeMode, type CouponType } from "@/domain/coupons";
import { issueGiftCardAction, saveCouponAction, togglePromoAction, voidGiftCardAction } from "./actions";
import type { CouponFormValues } from "./coupon-input";

export function PromoToggle({ id, active }: { id: string; active: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <button className="text-xs underline" disabled={pending} onClick={() => start(async () => (await togglePromoAction(id, !active), router.refresh()))}>
      {active ? "Turn off" : "Turn on"}
    </button>
  );
}

type Item = { id: string; name: string; kind?: string };
const num = (s: string) => (s.trim() === "" || !Number.isFinite(Number(s)) ? null : Math.max(0, Math.round(Number(s))));
const str = (n: number | null) => (n === null ? "" : String(n));
const BLANK: CouponFormValues = {
  code: "",
  description: null,
  type: "percent",
  value: 0,
  appliesTo: "services",
  serviceIds: [],
  productIds: [],
  freeItemKind: null,
  freeItemId: null,
  shopIds: [],
  minSpendCents: null,
  startsOn: null,
  endsOn: null,
  maxRedemptions: null,
  maxPerCustomer: null,
  codeMode: "shared",
  validDays: null,
  firstVisitOnly: false,
  stackable: false,
  autoApply: false,
  daysOfWeek: [],
  timeFrom: null,
  timeTo: null,
};

export function CouponForm({ initial, editingId, locked, shops, allShops, services, products }: { initial: CouponFormValues | null; editingId: string | null; locked: boolean; shops: Item[]; allShops: boolean; services: Item[]; products: Item[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [v, setV] = useState<CouponFormValues>(initial ?? { ...BLANK, shopIds: allShops ? [] : shops.map((s) => s.id) });
  const [valueText, setValueText] = useState(initial ? (initial.type === "amount" ? String(initial.value / 100) : String(initial.value)) : "");
  const [minSpend, setMinSpend] = useState(initial?.minSpendCents ? String(initial.minSpendCents / 100) : "");
  const set = (x: Partial<CouponFormValues>) => setV({ ...v, ...x });
  const perClient = v.maxPerCustomer === 1 ? "once" : v.maxPerCustomer === null ? "recurring" : "upto";
  const free = [...services.map((s) => ({ id: `${s.kind === "addon" ? "addon" : "service"}:${s.id}`, name: `${s.name}${s.kind === "addon" ? " (add-on)" : ""}` })), ...products.map((p) => ({ id: `product:${p.id}`, name: p.name }))];
  const submit = () =>
    start(async () => {
      const value = v.type === "free_item" ? 0 : v.type === "amount" ? Math.round(Number(valueText) * 100) : Math.round(Number(valueText));
      const r = await saveCouponAction(editingId, { ...v, value, minSpendCents: minSpend ? Math.round(Number(minSpend) * 100) : null });
      setError(r.ok ? null : r.error);
      if (!r.ok) return;
      if (editingId) router.push("/admin/promos");
      else {
        setV({ ...BLANK, shopIds: v.shopIds });
        setValueText("");
        setMinSpend("");
      }
      router.refresh();
    });
  return (
    <div className="space-y-4 border-t border-zinc-100 p-4" data-testid="coupon-form">
      <div className="flex items-center justify-between">
        <div className="text-sm font-semibold">{editingId ? `Edit ${initial?.code}` : "New coupon"}</div>
        {editingId && (
          <a className="text-xs underline" href="/admin/promos">
            Cancel
          </a>
        )}
      </div>
      <div className="grid gap-3 sm:grid-cols-4">
        <Field label={v.codeMode === "unique" ? "Code prefix" : "Code"} hint={locked ? "Used or sent, so the code stays" : v.codeMode === "unique" ? "Each client gets e.g. PREFIX-7K2Q9D" : undefined}>
          <Input className="uppercase" value={v.code} disabled={locked} onChange={(e) => set({ code: e.target.value.toUpperCase() })} />
        </Field>
        <Field label="Kind of codes">
          <Select value={v.codeMode} disabled={locked} onChange={(e) => set({ codeMode: e.target.value as CodeMode, autoApply: e.target.value === "unique" ? false : v.autoApply })}>
            {CODE_MODES.map((m) => (
              <option key={m} value={m}>
                {CODE_MODE_LABEL[m]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Discount">
          <Select value={v.type} onChange={(e) => set({ type: e.target.value as CouponType })}>
            {COUPON_TYPES.map((t) => (
              <option key={t} value={t}>
                {COUPON_TYPE_LABEL[t]}
              </option>
            ))}
          </Select>
        </Field>
        {v.type === "free_item" ? (
          <Field label="Free item" hint="One of it, when it's on the ticket">
            <Select
              value={v.freeItemId ? `${v.freeItemKind}:${v.freeItemId}` : ""}
              onChange={(e) => {
                const [kind, id] = e.target.value.split(":");
                set({ freeItemKind: (kind || null) as CouponFormValues["freeItemKind"], freeItemId: id || null });
              }}
            >
              <option value="">Pick one</option>
              {free.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </Select>
          </Field>
        ) : (
          <Field label={v.type === "percent" ? "Percent off" : "Dollars off"}>
            <Input inputMode="decimal" value={valueText} onChange={(e) => setValueText(e.target.value)} />
          </Field>
        )}
      </div>
      {v.type !== "free_item" && (
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="On">
            <Select value={v.appliesTo} onChange={(e) => set({ appliesTo: e.target.value as CouponFormValues["appliesTo"] })}>
              <option value="services">Services</option>
              <option value="products">Products</option>
              <option value="all">Everything</option>
            </Select>
          </Field>
          {v.appliesTo !== "products" && (
            <Field label="Only these services and add-ons" hint="None picked: every service">
              <ItemPicker placeholder="Search services" options={services} selected={v.serviceIds} onChange={(serviceIds) => set({ serviceIds })} />
            </Field>
          )}
          {v.appliesTo !== "services" && (
            <Field label="Only these products" hint="None picked: every product">
              <ItemPicker placeholder="Search products" options={products} selected={v.productIds} onChange={(productIds) => set({ productIds })} />
            </Field>
          )}
        </div>
      )}
      <Field label="Locations">
        <Chips
          options={[...(allShops ? [{ id: "", name: "All shops" }] : []), ...shops]}
          selected={v.shopIds.length ? v.shopIds : allShops ? [""] : []}
          onToggle={(id) => set({ shopIds: id === "" ? [] : toggle(v.shopIds, id) })}
        />
      </Field>
      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Field label="Minimum spend ($)">
          <Input inputMode="decimal" value={minSpend} onChange={(e) => setMinSpend(e.target.value)} />
        </Field>
        <Field label="Starts">
          <Input type="date" value={v.startsOn ?? ""} onChange={(e) => set({ startsOn: e.target.value || null })} />
        </Field>
        <Field label="Ends">
          <Input type="date" value={v.endsOn ?? ""} onChange={(e) => set({ endsOn: e.target.value || null })} />
        </Field>
        <Field label="Most uses in total">
          <Input inputMode="numeric" value={str(v.maxRedemptions)} onChange={(e) => set({ maxRedemptions: num(e.target.value) || null })} />
        </Field>
        <Field label="Use per client" hint={perClient === "once" ? "Each client uses it once" : perClient === "recurring" ? "Every visit, while it runs" : undefined}>
          <Select
            value={perClient}
            onChange={(e) => {
              const k = e.target.value as typeof perClient;
              set({ maxPerCustomer: k === "once" ? 1 : k === "recurring" ? null : Math.max(2, v.maxPerCustomer ?? 2) });
            }}
          >
            <option value="once">One time</option>
            <option value="recurring">Recurring (every visit)</option>
            <option value="upto">Up to a number of times</option>
          </Select>
        </Field>
        {perClient === "upto" && (
          <Field label="Times per client">
            <Input inputMode="numeric" value={str(v.maxPerCustomer)} onChange={(e) => set({ maxPerCustomer: Math.max(2, num(e.target.value) ?? 2) })} />
          </Field>
        )}
        {v.codeMode === "unique" && (
          <Field label="Code works for (days)">
            <Input inputMode="numeric" value={str(v.validDays)} onChange={(e) => set({ validDays: num(e.target.value) || null })} />
          </Field>
        )}
      </div>
      <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto]">
        <Field label="Days it works" hint="None picked: every day. Checked against the appointment's day at checkout.">
          <Chips
            options={DAY_NAMES.map((d, i) => ({ id: String(i), name: d }))}
            selected={v.daysOfWeek.map(String)}
            onToggle={(id) => set({ daysOfWeek: toggle(v.daysOfWeek.map(String), id).map(Number).sort((a, b) => a - b) })}
          />
        </Field>
        <Field label="From" hint="Blank: any time">
          <Input type="time" value={v.timeFrom ?? ""} onChange={(e) => set({ timeFrom: e.target.value || null, timeTo: e.target.value ? (v.timeTo ?? null) : null })} />
        </Field>
        <Field label="Until">
          <Input type="time" value={v.timeTo ?? ""} disabled={!v.timeFrom} onChange={(e) => set({ timeTo: e.target.value || null })} />
        </Field>
      </div>
      <div className="flex flex-wrap gap-5 text-sm">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={v.firstVisitOnly} onChange={(e) => set({ firstVisitOnly: e.target.checked })} />
          First visit only
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={v.stackable} onChange={(e) => set({ stackable: e.target.checked })} />
          Combines with other coupons and discounts
        </label>
        <label className="flex items-center gap-2" title="Needs a limit per client or first visit only">
          <input type="checkbox" checked={v.autoApply} disabled={v.codeMode === "unique"} onChange={(e) => set({ autoApply: e.target.checked })} />
          Apply automatically when the client qualifies
        </label>
      </div>
      <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
        <Field label="Description (staff and the booking page see it)">
          <Input value={v.description ?? ""} onChange={(e) => set({ description: e.target.value || null })} />
        </Field>
        <div className="flex items-end">
          <Button disabled={pending || !v.code} onClick={submit}>
            {editingId ? "Save coupon" : "Create coupon"}
          </Button>
        </div>
      </div>
      {error && <Notice tone="red">{error}</Notice>}
    </div>
  );
}

export function GiftCardTools({ shopId, initialQuery, canIssue }: { shopId: string; initialQuery: string; canIssue: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [q, setQ] = useState(initialQuery);
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState<{ tone: "green" | "red"; text: string } | null>(null);
  return (
    <div className="grid gap-4 border-b border-zinc-100 p-4 md:grid-cols-2">
      <form
        className="flex items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          router.push(`/admin/promos?gc=${encodeURIComponent(q)}`);
        }}
      >
        <Field label="Look up a card" className="flex-1">
          <Input className="uppercase" placeholder="Code" value={q} onChange={(e) => setQ(e.target.value.toUpperCase())} />
        </Field>
        <Button variant="secondary" type="submit">
          Search
        </Button>
      </form>
      <div className={canIssue ? "flex flex-wrap items-end gap-2" : "hidden"}>
        <Field label="Comp gift card $">
          <Input className="w-24" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <Field label="Reason" className="min-w-40 flex-1">
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Service recovery, giveaway…" />
        </Field>
        <Button
          disabled={pending}
          onClick={() =>
            start(async () => {
              const r = await issueGiftCardAction(shopId, Math.round(Number(amount) * 100), note);
              setMsg(r.ok ? { tone: "green", text: `Issued ${r.data.code}` } : { tone: "red", text: r.error });
              if (r.ok) setAmount("");
              router.refresh();
            })
          }
        >
          Issue
        </Button>
      </div>
      {msg && (
        <div className="md:col-span-2">
          <Notice tone={msg.tone}>{msg.text}</Notice>
        </div>
      )}
    </div>
  );
}

export function VoidGiftCard({ id }: { id: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <button
      className="text-xs text-red-600 underline"
      disabled={pending}
      onClick={() => {
        const reason = prompt("Reason for voiding this gift card?");
        if (reason) start(async () => (await voidGiftCardAction(id, reason), router.refresh()));
      }}
    >
      Void
    </button>
  );
}
