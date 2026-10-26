"use client";

import { useState } from "react";
import { Button, Card, CardHeader, Field, Input, Notice, Select, Textarea } from "@/components/ui";
import { FEE_CHANNELS, FEE_CHANNEL_LABEL, FEE_NOTICE_MAX, SURCHARGE_BLOCKED_STATES, US_STATES, type CardFeeOverride, type CardFeePolicy, feeConfigFor, stateRule } from "@/domain/card-fee-policy";
import { MAX_CARD_FEE_RATE, type CardFeeConfig, cardFeeFor, feeDisclosure } from "@/domain/checkout";
import { formatCents } from "@/lib/money";
import { saveBrandCardFeeAction, saveShopCardFeeAction } from "./actions";
import { SaveBar, useSave } from "./editors";

type Form = {
  enabled: boolean;
  type: CardFeePolicy["type"];
  rate: string;
  flat: string;
  appliesToTip: boolean;
  cap: string;
  min: string;
  channels: CardFeePolicy["channels"];
  funding: CardFeePolicy["funding"];
  notice: string;
};

const pct = (r: number) => (r * 100).toFixed(3).replace(/\.?0+$/, "");
const dollars = (c: number | null) => (c == null ? "" : (c / 100).toFixed(2));
const cents = (s: string) => Math.round((Number(s.replace(/[^0-9.]/g, "")) || 0) * 100);
const centsOrNull = (s: string) => (s.trim() ? cents(s) : null);

const toForm = (p: CardFeePolicy): Form => ({
  enabled: p.enabled,
  type: p.type,
  rate: pct(p.rate),
  flat: dollars(p.flatCents),
  appliesToTip: p.appliesToTip,
  cap: dollars(p.capCents),
  min: dollars(p.minCents),
  channels: p.channels,
  funding: p.funding,
  notice: p.notice ?? "",
});

const fromForm = (f: Form) => ({
  enabled: f.enabled,
  type: f.type,
  rate: Number(((Number(f.rate) || 0) / 100).toFixed(5)),
  flatCents: f.type === "percent" ? 0 : cents(f.flat),
  appliesToTip: f.appliesToTip,
  capCents: centsOrNull(f.cap),
  minCents: centsOrNull(f.min),
  channels: f.channels,
  funding: f.funding,
  notice: f.notice.trim() || null,
});

/** What the fee comes to on a few credit card charges, ignoring the shop's state. */
function examples(cfg: CardFeeConfig) {
  const on = { ...cfg, off: undefined };
  return [2500, 5000, 20000].map((c) => ({ cents: c, fee: cardFeeFor(on, "credit", { chargeCents: c }).feeCents }));
}

function FeeFields({ f, set, disabled, walletFlag }: { f: Form; set: (f: Form) => void; disabled: boolean; walletFlag: boolean }) {
  const preview = { ...fromForm(f), maxRate: MAX_CARD_FEE_RATE };
  const notice = feeDisclosure(preview);
  return (
    <fieldset disabled={disabled} className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
      <label className="flex items-center gap-2 text-sm sm:col-span-2 lg:col-span-4">
        <input type="checkbox" checked={f.enabled} onChange={(e) => set({ ...f, enabled: e.target.checked })} /> Add a surcharge to credit card payments
      </label>
      <Field label="Fee type">
        <Select value={f.type} onChange={(e) => set({ ...f, type: e.target.value as Form["type"] })}>
          <option value="percent">Percent</option>
          <option value="flat">Flat amount</option>
          <option value="both">Percent plus flat amount</option>
        </Select>
      </Field>
      {f.type !== "flat" && (
        <Field label={`Rate % (max ${MAX_CARD_FEE_RATE * 100})`}>
          <Input inputMode="decimal" value={f.rate} onChange={(e) => set({ ...f, rate: e.target.value })} />
        </Field>
      )}
      {f.type !== "percent" && (
        <Field label="Flat amount $">
          <Input inputMode="decimal" value={f.flat} placeholder="0.30" onChange={(e) => set({ ...f, flat: e.target.value })} />
        </Field>
      )}
      <label className="flex items-center gap-2 self-end pb-2 text-sm">
        <input type="checkbox" checked={f.appliesToTip} onChange={(e) => set({ ...f, appliesToTip: e.target.checked })} /> Charge it on the tip too
      </label>
      <Field label="Cap $ (optional)" hint="The most it can be on one charge">
        <Input inputMode="decimal" value={f.cap} placeholder="No cap" onChange={(e) => set({ ...f, cap: e.target.value })} />
      </Field>
      <Field label="Minimum $ (optional)" hint={`Never more than ${MAX_CARD_FEE_RATE * 100}% of the charge, even with a minimum`}>
        <Input inputMode="decimal" value={f.min} placeholder="No minimum" onChange={(e) => set({ ...f, min: e.target.value })} />
      </Field>
      <div className="sm:col-span-2">
        <div className="mb-1 text-xs font-medium text-zinc-700">Where it applies</div>
        <div className="grid gap-1 text-sm">
          {FEE_CHANNELS.map((c) => (
            <label key={c} className="flex items-center gap-2">
              <input type="checkbox" checked={f.channels[c]} onChange={(e) => set({ ...f, channels: { ...f.channels, [c]: e.target.checked } })} /> {FEE_CHANNEL_LABEL[c]}
            </label>
          ))}
        </div>
      </div>
      <div className="sm:col-span-2">
        <div className="mb-1 text-xs font-medium text-zinc-700">Card types besides credit</div>
        <div className="grid gap-1 text-sm">
          <label className="flex items-center gap-2 text-zinc-400" title="Card network rules and federal law don't allow surcharging debit cards">
            <input type="checkbox" checked={false} disabled /> Debit (never allowed)
          </label>
          <label className="flex items-center gap-2 text-zinc-400" title="Card network rules don't allow surcharging prepaid cards">
            <input type="checkbox" checked={false} disabled /> Prepaid (never allowed)
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={f.funding.applePay} onChange={(e) => set({ ...f, funding: { ...f.funding, applePay: e.target.checked } })} /> Credit cards in Apple Pay
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={f.funding.googlePay} onChange={(e) => set({ ...f, funding: { ...f.funding, googlePay: e.target.checked } })} /> Credit cards in Google Pay
          </label>
          {!walletFlag && (f.funding.applePay || f.funding.googlePay) && (
            <span className="text-xs text-amber-700">Wallet surcharges also need FEATURE_WALLET_FEE turned on; until then wallets pay none.</span>
          )}
        </div>
      </div>
      <Field
        label="Notice at checkout and on receipts"
        className="sm:col-span-2 lg:col-span-4"
        hint={`Optional; must say "surcharge". {fee} becomes the rate or amount. Up to ${FEE_NOTICE_MAX} characters.`}
      >
        <Textarea rows={2} maxLength={FEE_NOTICE_MAX} value={f.notice} placeholder="The built-in notice" onChange={(e) => set({ ...f, notice: e.target.value })} />
      </Field>
      <div className="space-y-1 text-xs text-zinc-600 sm:col-span-2 lg:col-span-4">
        {notice ? <div>Customers see: &ldquo;{notice}&rdquo;</div> : <div>No surcharge is shown or charged.</div>}
        {notice && (
          <div>
            On a credit card:{" "}
            {examples(preview)
              .map((x) => `${formatCents(x.cents)} → ${formatCents(x.fee)}`)
              .join(" · ")}
          </div>
        )}
      </div>
    </fieldset>
  );
}

/** The brand's surcharge policy: the fee, where it applies, waivers, refunds and the state rules. */
export function BrandCardFeeEditor({ initial, canEdit, walletFlag, shops }: { initial: CardFeePolicy; canEdit: boolean; walletFlag: boolean; shops: { name: string; state: string }[] }) {
  const { pending, msg, save } = useSave();
  const [f, setF] = useState(toForm(initial));
  const [waiverAllowed, setWaiverAllowed] = useState(initial.waiverAllowed);
  const [refundRule, setRefundRule] = useState(initial.refundRule);
  const [states, setStates] = useState(new Set(initial.states));
  const [limits, setLimits] = useState(Object.entries(initial.stateMaxRates).map(([s, r]) => ({ state: s, rate: pct(r) })));
  const [addLimit, setAddLimit] = useState("");
  const policy = (): Omit<CardFeePolicy, "appliesTo" | "shopIds" | "shopsCanEdit"> => ({
    ...fromForm(f),
    waiverAllowed,
    refundRule,
    states: [...states].sort(),
    stateMaxRates: Object.fromEntries(limits.map((l) => [l.state, Number(((Number(l.rate) || 0) / 100).toFixed(5))])),
  });
  const offShops = shops.filter((s) => !stateRule(policy(), s.state).allowed);
  const blocked = SURCHARGE_BLOCKED_STATES as readonly string[];
  return (
    <Card>
      <CardHeader
        title="Credit card surcharge (brand)"
        subtitle={canEdit ? "The rules at every shop it applies to, unless a shop sets its own. Every change is in the audit log." : "Brand admins change the card surcharge."}
      />
      <Notice tone="blue">
        Only credit cards are ever surcharged: Stripe reports each card&apos;s funding type, and debit, prepaid, gift cards and cash never pay it. It never goes over {MAX_CARD_FEE_RATE * 100}% of the
        charge or a state&apos;s lower limit, and it&apos;s off in any state not ticked below. Confirm card-brand registration and notice rules before turning it on.
      </Notice>
      <FeeFields f={f} set={setF} disabled={!canEdit} walletFlag={walletFlag} />
      <fieldset disabled={!canEdit} className="grid gap-3 border-t border-zinc-100 p-4 sm:grid-cols-2">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={waiverAllowed} onChange={(e) => setWaiverAllowed(e.target.checked)} /> Staff with permission may waive it on a ticket (reason required)
        </label>
        <Field label="On a refund" hint="A same-day void always gives the surcharge back">
          <Select value={refundRule} onChange={(e) => setRefundRule(e.target.value as CardFeePolicy["refundRule"])}>
            <option value="proportional">Refund its share of what&apos;s refunded</option>
            <option value="keep">Keep the surcharge</option>
          </Select>
        </Field>
        {refundRule === "keep" && (
          <div className="sm:col-span-2">
            <Notice>Visa and Mastercard rules may require giving the surcharge back on a refund. Check with your processor before keeping it.</Notice>
          </div>
        )}
        <div className="sm:col-span-2">
          <div className="mb-1 flex items-center justify-between text-xs font-medium text-zinc-700">
            <span>States where it may apply</span>
            {canEdit && (
              <span className="space-x-2 font-normal">
                <button type="button" className="underline" onClick={() => setStates(new Set(US_STATES.filter((s) => !blocked.includes(s))))}>
                  All but restricted
                </button>
                <button type="button" className="underline" onClick={() => setStates(new Set())}>
                  None
                </button>
              </span>
            )}
          </div>
          <div className="grid grid-cols-6 gap-1 text-xs sm:grid-cols-9 lg:grid-cols-13">
            {US_STATES.map((s) => (
              <label
                key={s}
                className={blocked.includes(s) ? "flex items-center gap-1 text-red-700" : "flex items-center gap-1"}
                title={blocked.includes(s) ? "Surcharges are restricted here" : undefined}
              >
                <input
                  type="checkbox"
                  checked={states.has(s)}
                  onChange={(e) => {
                    const n = new Set(states);
                    if (e.target.checked) n.add(s);
                    else n.delete(s);
                    setStates(n);
                  }}
                />
                {s}
              </label>
            ))}
          </div>
          <p className="mt-1 text-xs text-zinc-500">Red states restrict or ban surcharges ({blocked.join(", ")}). Confirm the current list with counsel; state law changes.</p>
        </div>
        <div className="sm:col-span-2">
          <div className="mb-1 text-xs font-medium text-zinc-700">Lower state limits</div>
          <div className="flex flex-wrap items-end gap-3">
            {limits.map((l, i) => (
              <span key={l.state} className="flex items-center gap-1 text-sm">
                {l.state}
                <Input className="w-16 py-1" inputMode="decimal" value={l.rate} onChange={(e) => setLimits(limits.map((x, k) => (k === i ? { ...x, rate: e.target.value } : x)))} />%
                {canEdit && (
                  <button type="button" className="text-xs underline" onClick={() => setLimits(limits.filter((_, k) => k !== i))}>
                    remove
                  </button>
                )}
              </span>
            ))}
            {canEdit && (
              <span className="flex items-center gap-1">
                <Select className="py-1" value={addLimit} onChange={(e) => setAddLimit(e.target.value)}>
                  <option value="">Add a state…</option>
                  {US_STATES.filter((s) => !limits.some((l) => l.state === s)).map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </Select>
                <Button size="sm" variant="secondary" disabled={!addLimit} onClick={() => (setLimits([...limits, { state: addLimit, rate: "2" }]), setAddLimit(""))}>
                  Add
                </Button>
              </span>
            )}
          </div>
        </div>
        {offShops.length > 0 && (
          <div className="sm:col-span-2">
            <Notice>No surcharge at {offShops.map((s) => `${s.name}${s.state ? ` (${s.state})` : " (no state set)"}`).join(", ")}: not on the state list.</Notice>
          </div>
        )}
      </fieldset>
      {canEdit && <SaveBar pending={pending} msg={msg} onClick={() => save(() => saveBrandCardFeeAction(policy()))} />}
    </Card>
  );
}

/** One shop's surcharge: the brand's, or its own fee, channels and notice. Waivers, refunds and states stay the brand's. */
export function ShopCardFeeEditor({
  shopId,
  shopName,
  shopState,
  brand,
  effective,
  overridden,
  applied,
  canEdit,
  brandAdmin,
  walletFlag,
}: {
  shopId: string;
  shopName: string;
  shopState: string;
  brand: CardFeePolicy;
  /** The brand's settings with this shop's own on top, whether or not the brand applies the fee here. */
  effective: CardFeePolicy;
  overridden: boolean;
  /** The brand applies the fee at this shop. */
  applied: boolean;
  canEdit: boolean;
  /** They set the brand's surcharge too (shown a link to it). */
  brandAdmin: boolean;
  walletFlag: boolean;
}) {
  const { pending, msg, save } = useSave();
  const [own, setOwn] = useState(overridden);
  const [f, setF] = useState(toForm(effective));
  const rule = stateRule(effective, shopState);
  const live = applied ? feeDisclosure(feeConfigFor(own ? { ...effective, ...fromForm(f) } : brand, shopState, "pos")) : null;
  const subtitle = canEdit
    ? "Follow the brand, or set this shop's own fee. Audited."
    : brand.shopsCanEdit
      ? "Brand admins and shop managers change the card surcharge."
      : "View only: the brand sets the card surcharge.";
  return (
    <Card>
      <CardHeader
        title={`Credit card surcharge at ${shopName}`}
        subtitle={subtitle}
        action={
          brandAdmin ? (
            <a href="/admin/card-fee" className="text-xs underline">
              Brand surcharge and shops
            </a>
          ) : undefined
        }
      />
      <div className="space-y-2 px-4 pt-4">
        {!applied && (
          <Notice tone="red">
            No surcharge here: the brand doesn&apos;t apply it at {shopName}.{brandAdmin ? " Turn it on under Credit card surcharge → Apply to shops." : ""}
          </Notice>
        )}
        {!rule.allowed && <Notice tone="red">No surcharge here: {shopState ? `${shopState} isn't` : "the shop has no state, so it isn't"} on the brand&apos;s state list.</Notice>}
        {rule.allowed && rule.maxRate < MAX_CARD_FEE_RATE && (
          <Notice>
            {shopState} limits the surcharge to {pct(rule.maxRate)}%; a higher rate is charged at that.
          </Notice>
        )}
        {rule.allowed && applied && <p className="text-xs text-zinc-600">{live ? `At the counter now: “${live}”` : "No surcharge at the counter."}</p>}
      </div>
      <fieldset disabled={!canEdit} className="flex gap-4 px-4 pt-3 text-sm">
        <label className="flex items-center gap-2">
          <input type="radio" checked={!own} onChange={() => setOwn(false)} /> Follow the brand
        </label>
        <label className="flex items-center gap-2">
          <input
            type="radio"
            checked={own}
            onChange={() => {
              setOwn(true);
              setF(toForm(effective));
            }}
          />{" "}
          Use this shop&apos;s own settings
        </label>
      </fieldset>
      {own ? <FeeFields f={f} set={setF} disabled={!canEdit} walletFlag={walletFlag} /> : <div className="p-4 text-xs text-zinc-500">Uses the brand&apos;s surcharge settings.</div>}
      {canEdit && <SaveBar pending={pending} msg={msg} onClick={() => save(() => saveShopCardFeeAction(shopId, own ? (fromForm(f) as CardFeeOverride) : null))} />}
    </Card>
  );
}
