"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button, Card, CardHeader, Field, Input, Notice, Select, Textarea } from "@/components/ui";
import type { LoyaltyConfig } from "@/domain/loyalty";
import { addClosureAction, createShopAction, removeClosureAction, saveHoursAction, saveLoyaltyAction, saveShopInfoAction, saveShopMoneyAction } from "./actions";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const mins = (s: string) => {
  const [h, m] = s.split(":").map(Number);
  return h * 60 + (m || 0);
};

function useSave() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const save = (fn: () => Promise<{ ok: true; data: unknown } | { ok: false; error: string }>, okText = "Saved") =>
    start(async () => {
      const r = await fn();
      setMsg(r.ok ? { ok: true, text: okText } : { ok: false, text: r.error });
      router.refresh();
    });
  return { pending, msg, save };
}

function SaveBar({ pending, msg, onClick, label = "Save", disabled }: { pending: boolean; msg: { ok: boolean; text: string } | null; onClick: () => void; label?: string; disabled?: boolean }) {
  return (
    <div className="flex items-center gap-3 border-t border-zinc-100 px-4 py-3">
      <Button disabled={pending || disabled} onClick={onClick}>
        {label}
      </Button>
      {msg && <span className={msg.ok ? "text-sm text-emerald-700" : "text-sm text-red-600"}>{msg.text}</span>}
    </div>
  );
}

type Info = {
  name: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  phone: string;
  email: string;
  description: string;
  bookingEnabled: boolean;
  cancelCutoffMinutes: number;
  minLeadMinutes: number;
  bookingWindowDays: number;
  bufferMinutes: number;
  tipPresets: number[];
};

export function ShopInfoEditor({ shopId, initial }: { shopId: string; initial: Info }) {
  const { pending, msg, save } = useSave();
  const [v, setV] = useState(initial);
  const [tips, setTips] = useState(initial.tipPresets.join(", "));
  const num = (k: keyof Info) => (e: React.ChangeEvent<HTMLInputElement>) => setV({ ...v, [k]: Number(e.target.value) || 0 });
  return (
    <Card>
      <CardHeader title="Shop & online booking" />
      <div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Name">
          <Input value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} />
        </Field>
        <Field label="Phone">
          <Input value={v.phone} onChange={(e) => setV({ ...v, phone: e.target.value })} />
        </Field>
        <Field label="Email">
          <Input value={v.email} onChange={(e) => setV({ ...v, email: e.target.value })} />
        </Field>
        <label className="flex items-center gap-2 self-end pb-2 text-sm">
          <input type="checkbox" checked={v.bookingEnabled} onChange={(e) => setV({ ...v, bookingEnabled: e.target.checked })} /> Online booking on
        </label>
        <Field label="Address" className="sm:col-span-2">
          <Input value={v.address} onChange={(e) => setV({ ...v, address: e.target.value })} />
        </Field>
        <Field label="City">
          <Input value={v.city} onChange={(e) => setV({ ...v, city: e.target.value })} />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="State">
            <Input maxLength={2} value={v.state} onChange={(e) => setV({ ...v, state: e.target.value.toUpperCase() })} />
          </Field>
          <Field label="ZIP">
            <Input value={v.zip} onChange={(e) => setV({ ...v, zip: e.target.value })} />
          </Field>
        </div>
        <Field label="Description" className="sm:col-span-2 lg:col-span-4">
          <Textarea rows={2} value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} />
        </Field>
        <Field label="Online cancel/reschedule cutoff (min)">
          <Input inputMode="numeric" value={v.cancelCutoffMinutes} onChange={num("cancelCutoffMinutes")} />
        </Field>
        <Field label="Minimum notice (min)">
          <Input inputMode="numeric" value={v.minLeadMinutes} onChange={num("minLeadMinutes")} />
        </Field>
        <Field label="Book up to (days ahead)">
          <Input inputMode="numeric" value={v.bookingWindowDays} onChange={num("bookingWindowDays")} />
        </Field>
        <Field label="Buffer between appts (min)">
          <Input inputMode="numeric" value={v.bufferMinutes} onChange={num("bufferMinutes")} />
        </Field>
        <Field label="Tip presets (%)" hint="Shown as big buttons at checkout">
          <Input value={tips} onChange={(e) => setTips(e.target.value)} />
        </Field>
      </div>
      <SaveBar
        pending={pending}
        msg={msg}
        onClick={() =>
          save(() =>
            saveShopInfoAction(shopId, {
              ...v,
              tipPresets: tips
                .split(/[,\s]+/)
                .map(Number)
                .filter((n) => n > 0),
            }),
          )
        }
      />
    </Card>
  );
}

type Money = { serviceTaxRate: number; productTaxRate: number; taxRatesVerified: boolean; cardFeeEnabled: boolean; cardFeeRate: number; cardFeeAppliesToTip: boolean };

export function MoneyEditor({ shopId, initial, canEdit }: { shopId: string; initial: Money; canEdit: boolean }) {
  const { pending, msg, save } = useSave();
  const [v, setV] = useState(initial);
  const [svc, setSvc] = useState((initial.serviceTaxRate * 100).toFixed(3).replace(/\.?0+$/, ""));
  const [prd, setPrd] = useState((initial.productTaxRate * 100).toFixed(3).replace(/\.?0+$/, ""));
  const [fee, setFee] = useState((initial.cardFeeRate * 100).toFixed(2).replace(/\.?0+$/, ""));
  return (
    <Card>
      <CardHeader title="Tax & card fee" subtitle={canEdit ? "Rates are stored per shop and snapshotted on every receipt." : "You can see but not change taxes and card fees."} />
      <fieldset disabled={!canEdit} className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Service tax %">
          <Input inputMode="decimal" value={svc} onChange={(e) => setSvc(e.target.value)} />
        </Field>
        <Field label="Product tax %">
          <Input inputMode="decimal" value={prd} onChange={(e) => setPrd(e.target.value)} />
        </Field>
        <label className="flex items-center gap-2 self-end pb-2 text-sm sm:col-span-2">
          <input type="checkbox" checked={v.taxRatesVerified} onChange={(e) => setV({ ...v, taxRatesVerified: e.target.checked })} /> Rates verified for this location
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={v.cardFeeEnabled} onChange={(e) => setV({ ...v, cardFeeEnabled: e.target.checked })} /> Charge a credit card fee
        </label>
        <Field label="Fee % (max 3)">
          <Input inputMode="decimal" value={fee} onChange={(e) => setFee(e.target.value)} />
        </Field>
        <label className="flex items-center gap-2 self-end pb-2 text-sm">
          <input type="checkbox" checked={v.cardFeeAppliesToTip} onChange={(e) => setV({ ...v, cardFeeAppliesToTip: e.target.checked })} /> Fee applies to tip
        </label>
        <div className="sm:col-span-2 lg:col-span-4">
          <Notice tone="blue">
            The fee is added only when Stripe reports the card&apos;s funding type as <b>credit</b>. Debit, prepaid, gift cards and cash never pay it. It&apos;s shown at checkout before charging and printed on the receipt. Check state rules before enabling: surcharging rules differ by state and card brand.
          </Notice>
        </div>
      </fieldset>
      {canEdit && (
        <SaveBar
          pending={pending}
          msg={msg}
          onClick={() => save(() => saveShopMoneyAction(shopId, { ...v, serviceTaxRate: Number(svc) / 100, productTaxRate: Number(prd) / 100, cardFeeRate: Number(fee) / 100 }))}
        />
      )}
    </Card>
  );
}

export function HoursEditor({ shopId, initial, canSetSunday }: { shopId: string; initial: { weekday: number; openMin: number; closeMin: number }[]; canSetSunday: boolean }) {
  const { pending, msg, save } = useSave();
  const [rows, setRows] = useState(initial);
  return (
    <Card>
      <CardHeader title="Opening hours" subtitle={`Barbers can only be booked inside shop hours. All shops are closed Sundays${canSetSunday ? "; opening one is up to you." : "; only the Brand Owner can change that."}`} />
      <div className="divide-y divide-zinc-100">
        {[1, 2, 3, 4, 5, 6, 0].map((d) => {
          const r = rows.find((x) => x.weekday === d);
          return (
            <div key={d} className="flex flex-wrap items-center gap-3 px-4 py-2 text-sm">
              <label className="flex w-36 items-center gap-2">
                <input
                  type="checkbox"
                  checked={!!r}
                  disabled={d === 0 && !canSetSunday && !r}
                  onChange={(e) => setRows(e.target.checked ? [...rows, { weekday: d, openMin: 9 * 60, closeMin: 18 * 60 }] : rows.filter((x) => x.weekday !== d))}
                />
                {DAYS[d]}
              </label>
              {r ? (
                <>
                  <input type="time" step={900} className="rounded px-2 py-1 ring-1 ring-zinc-300" value={hhmm(r.openMin)} onChange={(e) => setRows(rows.map((x) => (x === r ? { ...r, openMin: mins(e.target.value) } : x)))} />
                  <span>to</span>
                  <input type="time" step={900} className="rounded px-2 py-1 ring-1 ring-zinc-300" value={hhmm(r.closeMin)} onChange={(e) => setRows(rows.map((x) => (x === r ? { ...r, closeMin: mins(e.target.value) } : x)))} />
                </>
              ) : (
                <span className="text-zinc-400">Closed</span>
              )}
            </div>
          );
        })}
      </div>
      <SaveBar pending={pending} msg={msg} onClick={() => save(() => saveHoursAction(shopId, rows))} label="Save hours" />
    </Card>
  );
}

export function ClosuresEditor({ shopId, closures, multiShop }: { shopId: string; closures: { date: string; reason: string }[]; multiShop: boolean }) {
  const { pending, msg, save } = useSave();
  const [date, setDate] = useState("");
  const [reason, setReason] = useState("");
  const [all, setAll] = useState(false);
  return (
    <Card>
      <CardHeader title="Holidays & closures" subtitle="Closed dates block all booking for the day." />
      <ul className="divide-y divide-zinc-100 text-sm">
        {closures.length === 0 && <li className="px-4 py-2 text-zinc-500">No upcoming closures.</li>}
        {closures.map((c) => (
          <li key={c.date} className="flex items-center justify-between px-4 py-2">
            <span>
              <span className="font-medium">{c.date}</span> · {c.reason}
            </span>
            <button className="text-xs text-red-600 underline" onClick={() => save(() => removeClosureAction(shopId, c.date), "Removed")}>
              Remove
            </button>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-end gap-2 border-t border-zinc-100 p-4">
        <Field label="Date">
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field label="Reason" className="min-w-48 flex-1">
          <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Christmas Day" />
        </Field>
        {multiShop && (
          <label className="flex items-center gap-2 pb-2 text-sm">
            <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> All my shops
          </label>
        )}
        <Button disabled={pending || !date} onClick={() => save(() => addClosureAction(shopId, date, reason, all), "Added")}>
          Add closure
        </Button>
        {msg && <span className={msg.ok ? "text-sm text-emerald-700" : "text-sm text-red-600"}>{msg.text}</span>}
      </div>
    </Card>
  );
}

export function LoyaltyEditor({ initial }: { initial: LoyaltyConfig }) {
  const { pending, msg, save } = useSave();
  const [v, setV] = useState(initial);
  const [th, setTh] = useState(String(initial.thresholdCents / 100));
  const [rw, setRw] = useState(String(initial.rewardCents / 100));
  return (
    <Card>
      <CardHeader title="Loyalty (brand-wide)" subtitle="Value based: net service spend after discounts, before tax. Products, tips and gift cards never earn." />
      <div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={v.enabled} onChange={(e) => setV({ ...v, enabled: e.target.checked })} /> Loyalty on
        </label>
        <Field label="Every $ of service">
          <Input inputMode="decimal" value={th} onChange={(e) => setTh(e.target.value)} />
        </Field>
        <Field label="Earns $ reward">
          <Input inputMode="decimal" value={rw} onChange={(e) => setRw(e.target.value)} />
        </Field>
        <Field label="Rewards expire after (days)" hint="Blank = never">
          <Input inputMode="numeric" value={v.rewardExpiryDays ?? ""} onChange={(e) => setV({ ...v, rewardExpiryDays: e.target.value ? Number(e.target.value) : null })} />
        </Field>
        <Field label="Progress resets after no visit for (days)" hint="Blank = never">
          <Input inputMode="numeric" value={v.progressExpiryDays ?? ""} onChange={(e) => setV({ ...v, progressExpiryDays: e.target.value ? Number(e.target.value) : null })} />
        </Field>
        <Field label="Rewards can pay for">
          <Select value={v.redeemableOn} onChange={(e) => setV({ ...v, redeemableOn: e.target.value as LoyaltyConfig["redeemableOn"] })}>
            <option value="services">Services only</option>
            <option value="all">Services and products</option>
          </Select>
        </Field>
        <label className="flex items-center gap-2 self-end pb-2 text-sm">
          <input type="checkbox" checked={v.stackWithPromos} onChange={(e) => setV({ ...v, stackWithPromos: e.target.checked })} /> Combine with promo codes
        </label>
      </div>
      <SaveBar pending={pending} msg={msg} onClick={() => save(() => saveLoyaltyAction({ ...v, thresholdCents: Math.round(Number(th) * 100), rewardCents: Math.round(Number(rw) * 100) }))} />
    </Card>
  );
}

export function NewShopForm() {
  const { pending, msg, save } = useSave();
  const router = useRouter();
  const [v, setV] = useState({ name: "", address: "", city: "", state: "IA", zip: "", phone: "" });
  return (
    <Card id="new-shop" className="scroll-mt-20">
      <CardHeader title="Open a new location" subtitle="Starts with the full brand menu at default prices and Mon–Sat hours. Online booking stays off until you add barbers and turn it on." />
      <div className="grid gap-3 p-4 sm:grid-cols-3 lg:grid-cols-6">
        <Field label="Name" className="lg:col-span-2">
          <Input value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} placeholder="Davenport" />
        </Field>
        <Field label="Address" className="lg:col-span-2">
          <Input value={v.address} onChange={(e) => setV({ ...v, address: e.target.value })} />
        </Field>
        <Field label="City">
          <Input value={v.city} onChange={(e) => setV({ ...v, city: e.target.value })} />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="State">
            <Input maxLength={2} value={v.state} onChange={(e) => setV({ ...v, state: e.target.value.toUpperCase() })} />
          </Field>
          <Field label="ZIP">
            <Input value={v.zip} onChange={(e) => setV({ ...v, zip: e.target.value })} />
          </Field>
        </div>
        <Field label="Phone">
          <Input value={v.phone} onChange={(e) => setV({ ...v, phone: e.target.value })} />
        </Field>
      </div>
      <SaveBar pending={pending} msg={msg} label="Create shop" disabled={!v.name || !v.city} onClick={() =>
          save(async () => {
            const r = await createShopAction(v);
            if (r.ok) router.push(`/admin/setup?shop=${r.data.id}`);
            return r;
          }, "Shop created. Opening location setup…")
        }
      />
    </Card>
  );
}
