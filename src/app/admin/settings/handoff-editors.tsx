"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button, Card, CardHeader, Field, Input, cx } from "@/components/ui";
import { DEFAULT_TIP_SCREEN, MAX_TIP_PRESETS, type ShopHandoff, THANK_YOU_SECONDS, type TipScreen, tipChoices, tipScreenProblem } from "@/domain/handoff";
import { useSyncSave } from "@/components/brand-sync";
import { saveShopHandoffAction } from "./actions";

const asText = (t: TipScreen) => t.values.map((v) => (t.type === "percent" ? String(v) : (v / 100).toFixed(v % 100 ? 2 : 0))).join(", ");
const parse = (type: TipScreen["type"], text: string) =>
  text
    .split(/[,\s]+/)
    .filter(Boolean)
    .map((x) => (type === "percent" ? Number(x) : Math.round(Number(x.replace(/[$]/g, "")) * 100)))
    .filter((n) => Number.isFinite(n));

export function describeTips(t: TipScreen) {
  const vals = t.type === "percent" ? t.values.map((v) => `${v}%`) : t.values.map((v) => `$${(v / 100).toFixed(v % 100 ? 2 : 0)}`);
  return [vals.join(" / "), t.allowCustom && "custom", t.allowNoTip && "no tip"].filter(Boolean).join(", ");
}

/** Percent or dollar buttons for the customer screen, with custom and no-tip choices. */
export function TipPresetFields({ value, onChange }: { value: TipScreen; onChange: (t: TipScreen) => void }) {
  const [text, setText] = useState(asText(value));
  const problem = tipScreenProblem(value);
  const sample = tipChoices(value, 4000);
  const setType = (type: TipScreen["type"]) => {
    const values = type === value.type ? value.values : type === "percent" ? [...DEFAULT_TIP_SCREEN.values] : [500, 1000, 1500];
    setText(asText({ ...value, type, values }));
    onChange({ ...value, type, values });
  };
  return (
    <div className="space-y-3">
      <div className="flex w-fit rounded-lg bg-zinc-100 p-1 text-sm">
        {(["percent", "amount"] as const).map((t) => (
          <button key={t} type="button" onClick={() => setType(t)} className={cx("rounded-md px-3 py-1.5 font-medium", value.type === t ? "bg-white shadow-sm" : "text-zinc-600")}>
            {t === "percent" ? "Percent" : "Dollar amounts"}
          </button>
        ))}
      </div>
      <Field label={value.type === "percent" ? "Buttons (%)" : "Buttons ($)"} hint={`Up to ${MAX_TIP_PRESETS}, comma-separated, e.g. ${value.type === "percent" ? "18, 20, 25" : "5, 10, 15"}.`}>
        <Input
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            onChange({ ...value, values: parse(value.type, e.target.value) });
          }}
          aria-label="Tip buttons"
        />
      </Field>
      <div className="flex flex-wrap gap-4 text-sm text-zinc-700">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={value.allowCustom} onChange={(e) => onChange({ ...value, allowCustom: e.target.checked })} /> Custom tip
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={value.allowNoTip} onChange={(e) => onChange({ ...value, allowNoTip: e.target.checked })} /> No tip
        </label>
      </div>
      {problem ? (
        <p className="text-sm text-red-600">{problem}</p>
      ) : (
        <p className="text-xs text-zinc-500">
          On a $40 haircut: {sample.map((c) => (c.detail ? `${c.label} (${c.detail})` : c.label)).join(" · ")}
          {value.allowCustom ? " · Custom" : ""}
          {value.allowNoTip ? " · No tip" : ""}
        </p>
      )}
    </div>
  );
}

type Rules = Omit<ShopHandoff, "tips">;

function Choice<T extends string>({ name, value, options, onChange }: { name: string; value: T; options: readonly (readonly [T, string, string?])[]; onChange: (v: T) => void }) {
  return (
    <div className="space-y-1.5">
      {options.map(([v, label, hint]) => (
        <label key={v} className="flex items-start gap-2 text-sm text-zinc-700">
          <input type="radio" name={name} className="mt-0.5" checked={value === v} onChange={() => onChange(v)} />
          <span>
            {label}
            {hint && <span className="block text-xs text-zinc-500">{hint}</span>}
          </span>
        </label>
      ))}
    </div>
  );
}

/** Where the tip is entered, signature, whose PIN takes the device back and what happens after payment. */
export function HandoffRuleFields({ value, onChange, hasReaders }: { value: Rules; onChange: (r: Rules) => void; hasReaders: boolean }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <fieldset>
        <legend className="mb-1.5 text-xs font-medium text-zinc-700">Tip entry</legend>
        <Choice
          name="tipEntry"
          value={value.tipEntry}
          onChange={(tipEntry) => onChange({ ...value, tipEntry })}
          options={[
            ["screen", "On the customer screen"],
            ["reader", "On the Stripe Terminal reader", hasReaders ? "The reader shows the first three presets when the card is presented." : "Until a reader is registered, the screen asks for the tip."],
          ]}
        />
      </fieldset>
      <fieldset>
        <legend className="mb-1.5 text-xs font-medium text-zinc-700">Signature</legend>
        <label className="flex items-center gap-2 text-sm text-zinc-700">
          <input type="checkbox" checked={value.signature} onChange={(e) => onChange({ ...value, signature: e.target.checked })} /> Ask the client to sign before paying
        </label>
      </fieldset>
      <fieldset>
        <legend className="mb-1.5 text-xs font-medium text-zinc-700">Taking the device back</legend>
        <Choice
          name="unlock"
          value={value.unlock}
          onChange={(unlock) => onChange({ ...value, unlock })}
          options={[
            ["staff", "Any staff time clock PIN"],
            ["manager", "A manager's PIN only", "Roles with \u201cTake back a device handed to a client\u201d."],
          ]}
        />
      </fieldset>
      <fieldset>
        <legend className="mb-1.5 text-xs font-medium text-zinc-700">After payment</legend>
        <Choice
          name="afterPayment"
          value={value.afterPayment}
          onChange={(afterPayment) => onChange({ ...value, afterPayment })}
          options={[
            ["auto", "Thank-you screen, then back to staff by itself"],
            ["pin", "Thank-you screen until a staff PIN"],
          ]}
        />
        {value.afterPayment === "auto" && (
          <label className="mt-2 flex items-center gap-2 text-sm text-zinc-700">
            Show it for
            <Input
              className="w-16 py-1"
              inputMode="numeric"
              value={value.thankYouSeconds}
              onChange={(e) => onChange({ ...value, thankYouSeconds: Number(e.target.value.replace(/\D/g, "")) || 0 })}
              aria-label="Thank-you seconds"
            />
            seconds ({THANK_YOU_SECONDS.min} to {THANK_YOU_SECONDS.max})
          </label>
        )}
      </fieldset>
    </div>
  );
}

function useSave() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const save = <T,>(fn: () => Promise<{ ok: true; data: T } | { ok: false; error: string }>, okText: (d: T) => string) =>
    start(async () => {
      const r = await fn();
      setMsg(r.ok ? { ok: true, text: okText(r.data) } : { ok: false, text: r.error });
      if (r.ok) router.refresh();
    });
  return { pending, msg, save };
}

function SaveBar({ pending, msg, onClick, disabled }: { pending: boolean; msg: { ok: boolean; text: string } | null; onClick: () => void; disabled?: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-3 border-t border-zinc-100 px-4 py-3">
      <Button disabled={pending || disabled} onClick={onClick}>
        Save
      </Button>
      {msg && <span className={msg.ok ? "text-sm text-emerald-700" : "text-sm text-red-600"}>{msg.text}</span>}
    </div>
  );
}

export function ShopHandoffEditor({ shopId, shopName, initial, brandTips, hasReaders }: { shopId: string; shopName: string; initial: ShopHandoff; brandTips: TipScreen; hasReaders: boolean }) {
  const { pending, msg, save } = useSave();
  const { tips: initialTips, ...rules0 } = initial;
  const [own, setOwn] = useState(!!initialTips);
  const [tips, setTips] = useState<TipScreen>(initialTips ?? brandTips);
  const [rules, setRules] = useState<Rules>(rules0);
  return (
    <Card>
      <CardHeader
        title="Customer screen at checkout"
        subtitle={`"Hand to customer" turns the device to the client for the tip, signature, receipt and payment, locked to that ticket until a staff PIN. These are ${shopName}'s rules.`}
      />
      <div className="space-y-5 p-4">
        <fieldset className="space-y-2">
          <legend className="mb-1.5 text-xs font-medium text-zinc-700">Tip buttons</legend>
          <label className="flex items-center gap-2 text-sm text-zinc-700">
            <input type="radio" name="tipsource" checked={!own} onChange={() => setOwn(false)} /> The brand&apos;s: {describeTips(brandTips)}
          </label>
          <label className="flex items-center gap-2 text-sm text-zinc-700">
            <input type="radio" name="tipsource" checked={own} onChange={() => setOwn(true)} /> {shopName}&apos;s own
          </label>
          {own && (
            <div className="ml-6 rounded-lg bg-zinc-50 p-3 ring-1 ring-zinc-200">
              <TipPresetFields value={tips} onChange={setTips} />
            </div>
          )}
          <p className="text-xs text-zinc-500">Percent buttons are also the quick tips at the counter.</p>
        </fieldset>
        <HandoffRuleFields value={rules} onChange={setRules} hasReaders={hasReaders} />
      </div>
      <SaveBar
        pending={pending}
        msg={msg}
        disabled={own && !!tipScreenProblem(tips)}
        onClick={() =>
          save(
            () => saveShopHandoffAction(shopId, { ...rules, tips: own ? tips : null }),
            (r) => (r.status === "synced" ? "Saved, and the readers' tip screen is updated" : r.status === "failed" ? `Saved, but the readers weren't updated: ${r.error}` : "Saved"),
          )
        }
      />
    </Card>
  );
}

export function BrandTipsEditor({ initial }: { initial: TipScreen }) {
  const { pending, msg, save, dialog } = useSyncSave();
  const [tips, setTips] = useState(initial);
  return (
    <Card>
      <CardHeader title="Tip buttons on the customer screen" subtitle="Every location uses these unless it sets its own under its settings." />
      <div className="p-4">
        <TipPresetFields value={tips} onChange={setTips} />
      </div>
      <SaveBar pending={pending} msg={msg} disabled={!!tipScreenProblem(tips)} onClick={() => save({ label: "Tip presets", changes: [{ type: "tips", item: "screen", value: tips }] })} />
      {dialog}
    </Card>
  );
}
