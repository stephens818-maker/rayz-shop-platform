"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { useSettingSync, useSyncSave } from "@/components/brand-sync";
import { BrandLock, Button, Card, CardHeader, Field, Input, Notice, Select, Textarea } from "@/components/ui";
import type { ReceiptBranding } from "@/domain/connect";
import { LOYALTY_TYPES, LOYALTY_TYPE_LABEL, type LoyaltyConfig } from "@/domain/loyalty";
import type { ShopSettingPart } from "@/domain/permissions";
import { ordinal, type ReviewRules } from "@/domain/reviews";
import { SUPPORTED_TIMEZONE, US_TIMEZONES } from "@/domain/location-lifecycle";
import { registerReaderAction } from "../setup/actions";
import {
  addClosureAction,
  addReaderAction,
  removeClosureAction,
  saveHoursAction,
  saveReceiptAction,
  saveShopInfoAction,
  saveShopMoneyAction,
  saveShopProfileAction,
  setReaderActiveAction,
} from "./actions";
import { ReviewFields } from "./review-fields";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const mins = (s: string) => {
  const [h, m] = s.split(":").map(Number);
  return h * 60 + (m || 0);
};

export function useSave() {
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

export function SaveBar({ pending, msg, onClick, label = "Save", disabled }: { pending: boolean; msg: { ok: boolean; text: string } | null; onClick: () => void; label?: string; disabled?: boolean }) {
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
  twilioNumber: string;
  description: string;
  bookingEnabled: boolean;
  bookingMode: "platform" | "external";
  externalBookingUrl: string;
  cancelCutoffMinutes: number;
  minLeadMinutes: number;
  bookingWindowDays: number;
  bufferMinutes: number;
};

const PART_LABEL: Record<ShopSettingPart, string> = { details: "shop details", hours: "hours", booking: "online booking rules", checkout: "checkout", phone: "phone line" };

/** Each part (details, booking rules, phone line) is editable only with its permission; the rest shows read-only. */
export function ShopInfoEditor({ shopId, initial, editable, policiesLocked }: { shopId: string; initial: Info; editable: readonly ShopSettingPart[]; policiesLocked: boolean }) {
  const { pending, msg, save } = useSave();
  const [v, setV] = useState(initial);
  const num = (k: keyof Info) => (e: React.ChangeEvent<HTMLInputElement>) => setV({ ...v, [k]: Number(e.target.value) || 0 });
  const details = editable.includes("details");
  const booking = editable.includes("booking");
  const phone = editable.includes("phone");
  const locked = (["details", "booking", "phone"] as const).filter((p) => !editable.includes(p));
  return (
    <Card>
      <CardHeader title="Shop & online booking" subtitle={locked.length ? `You can see but not change the ${locked.map((p) => PART_LABEL[p]).join(" or ")}.` : undefined} />
      {booking && policiesLocked && <BrandLock what="The cutoff, notice, booking window and buffer" plural className="mx-4 mt-3" />}
      <div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Name">
          <Input disabled={!details} value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} />
        </Field>
        <Field label="Twilio number" hint="The text-enabled number: clients text and call it, and calls forward to the main phone in the location profile">
          <Input disabled={!phone} value={v.twilioNumber} placeholder="Not set up" onChange={(e) => setV({ ...v, twilioNumber: e.target.value })} />
        </Field>
        <label className="flex items-center gap-2 self-end pb-2 text-sm">
          <input type="checkbox" disabled={!booking} checked={v.bookingEnabled} onChange={(e) => setV({ ...v, bookingEnabled: e.target.checked })} /> Online booking on
        </label>
        <Field label="Where clients book" hint="While a shop moves over, the website and app can send its clients to its current booking site">
          <Select disabled={!booking} value={v.bookingMode} onChange={(e) => setV({ ...v, bookingMode: e.target.value as Info["bookingMode"] })}>
            <option value="platform">Here (website and app)</option>
            <option value="external">On an external booking site</option>
          </Select>
        </Field>
        {v.bookingMode === "external" && (
          <Field label="External booking link" className="sm:col-span-2 lg:col-span-3">
            <Input disabled={!booking} value={v.externalBookingUrl} placeholder="https://" onChange={(e) => setV({ ...v, externalBookingUrl: e.target.value })} />
          </Field>
        )}
        <Field label="Description" className="sm:col-span-2 lg:col-span-4">
          <Textarea disabled={!details} rows={2} value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} />
        </Field>
        <Field label="Online cancel/reschedule cutoff (min)">
          <Input disabled={!booking || policiesLocked} inputMode="numeric" value={v.cancelCutoffMinutes} onChange={num("cancelCutoffMinutes")} />
        </Field>
        <Field label="Minimum notice (min)">
          <Input disabled={!booking || policiesLocked} inputMode="numeric" value={v.minLeadMinutes} onChange={num("minLeadMinutes")} />
        </Field>
        <Field label="Book up to (days ahead)">
          <Input disabled={!booking || policiesLocked} inputMode="numeric" value={v.bookingWindowDays} onChange={num("bookingWindowDays")} />
        </Field>
        <Field label="Buffer between appts (min)">
          <Input disabled={!booking || policiesLocked} inputMode="numeric" value={v.bufferMinutes} onChange={num("bufferMinutes")} />
        </Field>
      </div>
      <SaveBar
        pending={pending}
        msg={msg}
        onClick={() =>
          save(() => saveShopInfoAction(shopId, v))
        }
      />
    </Card>
  );
}

type Money = { serviceTaxRate: number; productTaxRate: number; taxRatesVerified: boolean };

export function MoneyEditor({ shopId, initial, canEdit, ratesLocked }: { shopId: string; initial: Money; canEdit: boolean; ratesLocked: boolean }) {
  const { pending, msg, save } = useSave();
  const [v, setV] = useState(initial);
  const [svc, setSvc] = useState((initial.serviceTaxRate * 100).toFixed(3).replace(/\.?0+$/, ""));
  const [prd, setPrd] = useState((initial.productTaxRate * 100).toFixed(3).replace(/\.?0+$/, ""));
  return (
    <Card>
      <CardHeader title="Tax" subtitle={canEdit ? "Rates are stored per shop and snapshotted on every receipt." : "You can see but not change taxes."} />
      {canEdit && ratesLocked && <BrandLock what="Tax rates" plural className="mx-4 mt-3" />}
      <fieldset disabled={!canEdit} className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Service tax %">
          <Input inputMode="decimal" value={svc} disabled={ratesLocked} onChange={(e) => setSvc(e.target.value)} />
        </Field>
        <Field label="Product tax %">
          <Input inputMode="decimal" value={prd} disabled={ratesLocked} onChange={(e) => setPrd(e.target.value)} />
        </Field>
        <label className="flex items-center gap-2 self-end pb-2 text-sm sm:col-span-2">
          <input type="checkbox" checked={v.taxRatesVerified} onChange={(e) => setV({ ...v, taxRatesVerified: e.target.checked })} /> Rates verified for this location
        </label>
      </fieldset>
      {canEdit && (
        <SaveBar
          pending={pending}
          msg={msg}
          onClick={() => save(() => saveShopMoneyAction(shopId, { ...v, serviceTaxRate: Number(svc) / 100, productTaxRate: Number(prd) / 100 }))}
        />
      )}
    </Card>
  );
}

/** A shop's opening hours, or with no shop the brand's hours template that new shops start from and a sync pushes. */
export function HoursEditor({ shopId, initial, canSetSunday, locked = false }: { shopId: string | null; initial: { weekday: number; openMin: number; closeMin: number }[]; canSetSunday: boolean; locked?: boolean }) {
  const shop = useSave();
  const brand = useSyncSave();
  const { pending, msg } = shopId ? shop : brand;
  const [rows, setRows] = useState(initial);
  return (
    <Card>
      {shopId ? (
        <CardHeader title="Opening hours" subtitle={`Barbers can only be booked inside shop hours. All shops are closed Sundays${canSetSunday ? "; opening one is up to you." : "; only the Brand Owner can change that."}`} />
      ) : (
        <CardHeader title="Hours template" subtitle="The weekly hours new shops open with. Saving lets you push them to shops; closed dates stay each shop's own." />
      )}
      {locked && <BrandLock what="Opening hours" plural className="mx-4 mt-3" />}
      <fieldset disabled={locked} className="divide-y divide-zinc-100">
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
      </fieldset>
      {!locked && (
      <SaveBar
        pending={pending}
        msg={msg}
        onClick={() => (shopId ? shop.save(() => saveHoursAction(shopId, rows)) : brand.save({ label: "Hours template", changes: [{ type: "hours", item: "week", value: rows }] }))}
        label="Save hours"
      />
      )}
      {brand.dialog}
    </Card>
  );
}

export function ClosuresEditor({ shopId, closures, multiShop, brand = false }: { shopId: string; closures: { date: string; reason: string }[]; multiShop: boolean; brand?: boolean }) {
  const { pending, msg, save } = useSave();
  const [date, setDate] = useState("");
  const [reason, setReason] = useState("");
  const [all, setAll] = useState(false);
  return (
    <Card>
      <CardHeader title="Holidays & closures" subtitle={brand ? "Closed dates block all booking for the day. To close several shops at once, use Brand defaults → Holiday closures." : "Closed dates block all booking for the day."} />
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
        {multiShop && !brand && (
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

export function LoyaltyEditor({ initial, shops }: { initial: LoyaltyConfig; shops: { id: string; name: string; status: string }[] }) {
  const { pending, msg, save, dialog } = useSyncSave();
  const [v, setV] = useState(initial);
  const [th, setTh] = useState(String(initial.thresholdCents / 100));
  const [rw, setRw] = useState(String(initial.rewardCents / 100));
  const [min, setMin] = useState(initial.minVisitCents ? String(initial.minVisitCents / 100) : "");
  const all = v.shopIds === null;
  const assigned = (id: string) => all || v.shopIds!.includes(id);
  const toggleShop = (id: string) => {
    const now = all ? shops.map((s) => s.id) : v.shopIds!;
    setV({ ...v, shopIds: now.includes(id) ? now.filter((x) => x !== id) : [...now, id] });
  };
  const typeChanged = v.type !== initial.type;
  const counts = ["Services", ...(v.includeProducts ? ["products"] : []), ...(v.includeTips ? ["tips"] : [])].join(", ");
  return (
    <Card data-testid="loyalty-editor">
      <CardHeader title="Loyalty program (brand-wide)" subtitle={`${counts} count, net of discounts and before tax. Gift cards never earn. Clients earn and spend rewards only at the assigned locations.`} />
      <div className="space-y-4 p-4">
        <label className="flex items-center gap-2 text-sm font-medium">
          <input type="checkbox" checked={v.enabled} onChange={(e) => setV({ ...v, enabled: e.target.checked })} data-testid="loyalty-enabled" /> Enabled
        </label>
        <div role="radiogroup" aria-label="Program type" className="grid gap-2 sm:grid-cols-2">
          {LOYALTY_TYPES.map((t) => (
            <label key={t} className={`flex cursor-pointer items-start gap-2 rounded-lg p-3 text-sm ring-1 ring-inset ${v.type === t ? "bg-brand-50 ring-2 ring-brand-600" : "ring-zinc-200"}`}>
              <input type="radio" name="loyalty-type" className="mt-1" checked={v.type === t} onChange={() => setV({ ...v, type: t })} data-testid={`loyalty-type-${t}`} />
              <span>
                <span className="font-medium">{LOYALTY_TYPE_LABEL[t]}</span>
                <span className="block text-xs text-zinc-500">{t === "value" ? "Every $ spent earns toward the reward, e.g. $15 for every $300." : "Every paid visit counts once, e.g. $15 after 10 visits."}</span>
              </span>
            </label>
          ))}
        </div>
        {typeChanged && (
          <Notice tone="amber">
            Switching to {LOYALTY_TYPE_LABEL[v.type].toLowerCase()} carries every client&apos;s progress over as the same share of the way to a reward (rounded down), when you save. Rewards already earned stay.
          </Notice>
        )}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {v.type === "value" ? (
            <Field label="Goal: every $ spent">
              <Input inputMode="decimal" value={th} onChange={(e) => setTh(e.target.value)} data-testid="loyalty-threshold" />
            </Field>
          ) : (
            <>
              <Field label="Goal: paid visits">
                <Input inputMode="numeric" value={v.visitsGoal} onChange={(e) => setV({ ...v, visitsGoal: Number(e.target.value) || 0 })} data-testid="loyalty-visits" />
              </Field>
              <Field label="A visit counts from $" hint="Blank = any paid visit">
                <Input inputMode="decimal" value={min} onChange={(e) => setMin(e.target.value)} />
              </Field>
            </>
          )}
          <Field label="Earns $ reward">
            <Input inputMode="decimal" value={rw} onChange={(e) => setRw(e.target.value)} data-testid="loyalty-reward" />
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
        </div>
        <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={v.includeProducts} onChange={(e) => setV({ ...v, includeProducts: e.target.checked })} data-testid="loyalty-products" /> Include product sales
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={v.includeTips} onChange={(e) => setV({ ...v, includeTips: e.target.checked })} data-testid="loyalty-tips" /> Include tips
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={v.stackWithPromos} onChange={(e) => setV({ ...v, stackWithPromos: e.target.checked })} /> Combine with promo codes
          </label>
        </div>
        <fieldset>
          <legend className="text-sm font-medium">Assigned shops</legend>
          <p className="text-xs text-zinc-500">Tickets at other locations don&apos;t earn, and rewards can&apos;t be used there. {all ? "Every location, including ones you open later." : `${v.shopIds!.length} of ${shops.length}.`}</p>
          <div className="mt-2 grid gap-1 sm:grid-cols-3" data-testid="loyalty-shops">
            {shops.map((s) => (
              <label key={s.id} className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={assigned(s.id)} onChange={() => toggleShop(s.id)} />
                {s.name}
                {s.status !== "live" && <span className="text-xs text-zinc-400">({s.status})</span>}
              </label>
            ))}
          </div>
          {!all && (
            <button type="button" className="mt-1 text-xs underline" onClick={() => setV({ ...v, shopIds: null })}>
              Every location, including new ones
            </button>
          )}
        </fieldset>
      </div>
      <SaveBar
        pending={pending}
        msg={msg}
        onClick={() =>
          save({
            label: "Loyalty program",
            changes: [
              {
                type: "loyalty",
                item: "brand",
                value: {
                  ...v,
                  thresholdCents: Math.round(Number(th) * 100),
                  rewardCents: Math.round(Number(rw) * 100),
                  minVisitCents: min.trim() ? Math.round(Number(min) * 100) : 0,
                },
              },
            ],
          })
        }
      />
      {dialog}
    </Card>
  );
}

export function ProfileEditor({
  shopId,
  initial,
  canChangeLink,
  accentLocked,
}: {
  shopId: string;
  initial: { slug: string; timezone: string; accentColor: string; logoUrl: string };
  canChangeLink: boolean;
  accentLocked: boolean;
}) {
  const { pending, msg, save } = useSave();
  const [v, setV] = useState(initial);
  return (
    <Card>
      <CardHeader title="Booking link, time zone and branding" subtitle="The link clients book at, and how this location's booking page looks." />
      <div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Booking link" hint={canChangeLink ? "/book/… · never a surname. Changing it breaks old links." : "Only the Brand Owner or a Brand Admin can change it."}>
          <Input value={v.slug} disabled={!canChangeLink} onChange={(e) => setV({ ...v, slug: e.target.value.toLowerCase() })} />
        </Field>
        <Field label="Time zone" hint={v.timezone !== SUPPORTED_TIMEZONE ? "Every shop runs on Central time today." : undefined}>
          <Select value={v.timezone} disabled={!canChangeLink} onChange={(e) => setV({ ...v, timezone: e.target.value })}>
            {US_TIMEZONES.map((z) => (
              <option key={z.id} value={z.id}>
                {z.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Accent color" hint={accentLocked ? "Set by the brand (Setup → Sync status)." : "Blank uses the brand's."}>
          <Input value={v.accentColor} placeholder="#1f2937" disabled={accentLocked} onChange={(e) => setV({ ...v, accentColor: e.target.value })} />
        </Field>
        <Field label="Logo web address">
          <Input type="url" value={v.logoUrl} onChange={(e) => setV({ ...v, logoUrl: e.target.value })} />
        </Field>
      </div>
      <SaveBar pending={pending} msg={msg} onClick={() => save(() => saveShopProfileAction(shopId, v))} />
    </Card>
  );
}

type ReaderRow = { id: string; label: string; serialNumber: string | null; stripeReaderId: string | null; deviceType: string | null; stripeLocationId: string | null; active: boolean };

export function ReadersEditor({ shopId, shopName, terminalLocationId, readers }: { shopId: string; shopName: string; terminalLocationId: string | null; readers: ReaderRow[] }) {
  const { pending, msg, save } = useSave();
  const [v, setV] = useState({ label: "", serialNumber: "", registrationCode: "" });
  const [manual, setManual] = useState(false);
  const [m, setM] = useState({ label: "", serialNumber: "", stripeReaderId: "" });
  return (
    <Card>
      <CardHeader
        title="Card readers"
        subtitle={`Stripe Terminal readers at ${shopName}, registered to its own Terminal location${terminalLocationId ? ` (${terminalLocationId})` : ""} so their payments land in its books.`}
      />
      <ul className="divide-y divide-zinc-100">
        {readers.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-sm">
            <span className={r.active ? "text-zinc-900" : "text-zinc-400 line-through"}>
              {r.label}
              <span className="ml-2 text-xs text-zinc-500">
                {[r.serialNumber, r.stripeReaderId ?? "not registered yet", r.deviceType?.replace(/_/g, " "), r.stripeLocationId && r.stripeLocationId !== terminalLocationId ? `location ${r.stripeLocationId}` : null]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </span>
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => save(() => setReaderActiveAction(r.id, !r.active))}>
              {r.active ? "Retire" : "Bring back"}
            </Button>
          </li>
        ))}
        {readers.length === 0 && <li className="px-4 py-3 text-sm text-zinc-500">No readers yet. Cards can still be keyed in at checkout.</li>}
      </ul>
      <div className="space-y-2 border-t border-zinc-100 p-4">
        <p className="text-sm text-zinc-500">
          On the reader, open Settings and choose Generate pairing code, then enter the code here. In Stripe test mode, the code simulated-wpe registers a simulated WisePOS E.
        </p>
        <div className="flex flex-wrap gap-2">
          <Input className="w-48" placeholder="Front counter" aria-label="Reader name" value={v.label} onChange={(e) => setV({ ...v, label: e.target.value })} />
          <Input className="w-44" placeholder="Serial number (optional)" aria-label="Serial number" value={v.serialNumber} onChange={(e) => setV({ ...v, serialNumber: e.target.value })} />
          <Input className="w-52" placeholder="Registration code" aria-label="Registration code" value={v.registrationCode} onChange={(e) => setV({ ...v, registrationCode: e.target.value })} />
          <Button
            variant="secondary"
            disabled={pending || !v.label.trim() || !v.registrationCode.trim()}
            onClick={() =>
              save(async () => {
                const r = await registerReaderAction(shopId, { ...v, serialNumber: v.serialNumber.trim() || null });
                if (r.ok) setV({ label: "", serialNumber: "", registrationCode: "" });
                return r;
              }, "Reader registered")
            }
          >
            Register reader
          </Button>
          {msg && <span className={msg.ok ? "self-center text-sm text-emerald-700" : "self-center text-sm text-red-600"}>{msg.text}</span>}
        </div>
        {manual ? (
          <div className="flex flex-wrap gap-2">
            <Input className="w-48" placeholder="Front counter" aria-label="Reader name (already registered)" value={m.label} onChange={(e) => setM({ ...m, label: e.target.value })} />
            <Input className="w-44" placeholder="Serial number" aria-label="Serial number (already registered)" value={m.serialNumber} onChange={(e) => setM({ ...m, serialNumber: e.target.value })} />
            <Input className="w-52" placeholder="Stripe reader ID (tmr_…)" aria-label="Stripe reader ID" value={m.stripeReaderId} onChange={(e) => setM({ ...m, stripeReaderId: e.target.value })} />
            <Button
              variant="ghost"
              disabled={pending || !m.label.trim()}
              onClick={() =>
                save(async () => {
                  const r = await addReaderAction(shopId, m);
                  if (r.ok) setM({ label: "", serialNumber: "", stripeReaderId: "" });
                  return r;
                }, "Reader added")
              }
            >
              Add
            </Button>
          </div>
        ) : (
          <button type="button" className="text-sm text-brand-700 hover:underline" onClick={() => setManual(true)}>
            Already registered in Stripe? Add it by reader ID
          </button>
        )}
      </div>
    </Card>
  );
}

export function ReceiptEditor({ shopId, shopName, initial, brandReviews, locked }: { shopId: string; shopName: string; initial: ReceiptBranding; brandReviews: ReviewRules; locked: boolean }) {
  const { pending, msg, save } = useSave();
  const [v, setV] = useState({ ...initial, headline: initial.headline ?? "", footer: initial.footer ?? "", reviewUrl: initial.reviewUrl ?? "" });
  return (
    <Card>
      <CardHeader title="Receipts" subtitle={`What ${shopName}'s digital receipts show. Clients get a text with a link or an email, or no receipt.`} />
      {locked && <BrandLock what="The headline, footer, what's shown and the Print button" plural className="mx-4 mt-3" />}
      <div className="grid gap-3 p-4 sm:grid-cols-2">
        <Field label="Headline" hint={`Blank prints "Ray'z Barber Shop · ${shopName}".`}>
          <Input maxLength={60} value={v.headline} disabled={locked} onChange={(e) => setV({ ...v, headline: e.target.value })} />
        </Field>
        <Field label="Footer" hint="Blank prints the brand's thank-you line.">
          <Input maxLength={200} value={v.footer} disabled={locked} onChange={(e) => setV({ ...v, footer: e.target.value })} />
        </Field>
        <fieldset disabled={locked} className="flex flex-wrap gap-4 text-sm text-zinc-700 sm:col-span-2">
          {(
            [
              ["showLogo", "Logo"],
              ["showAddress", "Address"],
              ["showPhone", "Phone"],
            ] as const
          ).map(([k, label]) => (
            <label key={k} className="flex items-center gap-2">
              <input type="checkbox" checked={v[k]} onChange={(e) => setV({ ...v, [k]: e.target.checked })} /> {label}
            </label>
          ))}
        </fieldset>
        <ReviewFields value={v} brand={brandReviews} onChange={(r) => setV({ ...v, ...r })} />
        <label className="flex items-center gap-2 text-sm text-zinc-700 sm:col-span-2">
          <input type="checkbox" checked={v.allowPrint} disabled={locked} onChange={(e) => setV({ ...v, allowPrint: e.target.checked })} /> Show a Print button on the staff receipt (paper is off by default)
        </label>
      </div>
      <SaveBar
        pending={pending}
        msg={msg}
        onClick={() => save(() => saveReceiptAction(shopId, { ...v, headline: v.headline.trim() || null, footer: v.footer.trim() || null, reviewUrl: v.reviewUrl.trim() || null }))}
      />
    </Card>
  );
}

/** The brand's rules for the Google review link; each location can set its own under Receipts. */
export function ReviewRulesEditor({ initial }: { initial: ReviewRules }) {
  const { pending, msg, saveSetting, dialog } = useSettingSync("reviews");
  const [v, setV] = useState({ minVisits: String(initial.minVisits), snoozeDays: String(initial.snoozeDays) });
  const minVisits = Number(v.minVisits);
  const snoozeDays = Number(v.snoozeDays);
  const valid = /^\d+$/.test(v.minVisits) && minVisits >= 1 && minVisits <= 50 && /^\d+$/.test(v.snoozeDays) && snoozeDays <= 365;
  return (
    <Card>
      <CardHeader
        title="Google reviews"
        subtitle="When receipts and the follow-up after a visit include Leave a review, for every location that has a review link. A location can set its own under Receipts."
      />
      <div className="grid gap-3 p-4 sm:grid-cols-2" data-testid="review-rules">
        <Field label="Show Leave a review from visit" hint="Completed visits (checked out, not cancelled or no-show) at any location. 1 shows it to everyone.">
          <Input type="number" min={1} max={50} value={v.minVisits} onChange={(e) => setV({ ...v, minVisits: e.target.value })} data-testid="brand-review-min-visits" />
        </Field>
        <Field label="After a tap, don't ask again for (days)" hint="At the location whose link they tapped, on later receipts and follow-ups. 0 never pauses.">
          <Input type="number" min={0} max={365} value={v.snoozeDays} onChange={(e) => setV({ ...v, snoozeDays: e.target.value })} data-testid="brand-review-snooze-days" />
        </Field>
        <p className="text-xs text-zinc-500 sm:col-span-2">
          {valid
            ? `${minVisits <= 1 ? "Every client sees" : `Clients from their ${ordinal(minVisits)} visit on see`} the button${snoozeDays > 0 ? `, then not again at that location for ${snoozeDays} days after they tap it` : ""}. `
            : ""}
          Only the visit count decides: never a rating, tip, refund or complaint, since asking only happy clients is against Google&apos;s policy. We can&apos;t see whether
          someone actually posted a review, so a tap on the link counts.
        </p>
      </div>
      <SaveBar pending={pending} msg={msg} disabled={!valid} onClick={() => saveSetting({ minVisits, snoozeDays })} />
      {dialog}
    </Card>
  );
}
