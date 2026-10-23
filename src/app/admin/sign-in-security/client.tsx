"use client";

import { useState } from "react";
import { NetworkRuleFields, ruleDraft, ruleFromDraft } from "@/components/network-rule-fields";
import { Button, Field, Input, Select } from "@/components/ui";
import { useAction } from "@/components/use-action";
import type { BrandNetworkSettings, ShopNetworkRule } from "@/domain/network-access";
import { decideDeviceAction, saveBrandNetworkAction, saveShopRuleAction, trustThisDeviceAction } from "./actions";

function Saved({ ok, error }: { ok: boolean; error: string | null }) {
  if (error) return <span className="text-xs text-red-700">{error}</span>;
  return ok ? <span className="text-xs text-emerald-700">Saved.</span> : null;
}

export function ShopRuleEditor({ shopId, shopName, initial, myIp, exempt }: { shopId: string; shopName: string; initial: ShopNetworkRule; myIp: string | null; exempt: boolean }) {
  const { pending, error, run } = useAction();
  const [v, setV] = useState(ruleDraft(initial));
  const [saved, setSaved] = useState(v);
  const [ok, setOk] = useState(false);
  const dirty = JSON.stringify(v) !== JSON.stringify(saved);
  return (
    <form
      className="space-y-3 p-4"
      data-testid={`network-rule-${shopId}`}
      onSubmit={(e) => {
        e.preventDefault();
        run(
          () => saveShopRuleAction(shopId, ruleFromDraft(v)),
          (rule) => {
            setV(ruleDraft(rule));
            setSaved(ruleDraft(rule));
            setOk(true);
          },
        );
      }}
    >
      <NetworkRuleFields
        value={v}
        onChange={(x) => {
          setOk(false);
          setV(x);
        }}
        myIp={myIp}
        exempt={exempt}
        shopName={shopName}
      />
      {(v.enabled || dirty || ok || error) && (
        <div className="flex items-center gap-3">
          <Button disabled={pending}>Save {shopName}</Button>
          <Saved ok={ok} error={error} />
        </div>
      )}
    </form>
  );
}

export function AlertToggle({ initial }: { initial: BrandNetworkSettings }) {
  const { pending, error, run } = useAction();
  const [on, setOn] = useState(initial.alertOnBlock);
  const [ok, setOk] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-3 p-4 text-sm">
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={on}
          disabled={pending}
          onChange={(e) => {
            const next = e.target.checked;
            setOn(next);
            setOk(false);
            run(() => saveBrandNetworkAction({ alertOnBlock: next }), () => setOk(true));
          }}
        />
        Email the Brand Owner and brand admins when a sign-in is blocked
      </label>
      <span className="text-xs text-zinc-500">At most once an hour per person and location. Every attempt is in the list below either way.</span>
      <Saved ok={ok} error={error} />
    </div>
  );
}

export function DeviceButtons({ id, status, own }: { id: string; status: "pending" | "approved"; own: boolean }) {
  const { pending, error, run } = useAction();
  return (
    <div className="flex flex-wrap items-center justify-end gap-1.5">
      {status === "pending" ? (
        <>
          <Button size="sm" disabled={pending || own} title={own ? "You asked for this one, so someone else approves it" : undefined} onClick={() => run(() => decideDeviceAction(id, "approve"))}>
            Approve
          </Button>
          <Button size="sm" variant="secondary" disabled={pending} onClick={() => run(() => decideDeviceAction(id, "decline"))}>
            Decline
          </Button>
        </>
      ) : (
        <Button size="sm" variant="secondary" disabled={pending} onClick={() => run(() => decideDeviceAction(id, "revoke"))}>
          Remove
        </Button>
      )}
      {error && <span className="text-xs text-red-700">{error}</span>}
    </div>
  );
}

export function TrustThisDevice({ shops }: { shops: { id: string; name: string }[] }) {
  const { pending, error, run } = useAction();
  const [shopId, setShopId] = useState(shops[0]?.id ?? "");
  const [label, setLabel] = useState("");
  const [ok, setOk] = useState(false);
  if (!shops.length) return null;
  return (
    <form
      className="flex flex-wrap items-end gap-2 p-4"
      onSubmit={(e) => {
        e.preventDefault();
        run(
          () => trustThisDeviceAction({ shopId, label }),
          () => {
            setOk(true);
            setLabel("");
          },
        );
      }}
    >
      <Field label="Name this device">
        <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Front desk iPad" maxLength={40} required className="w-56" />
      </Field>
      {shops.length > 1 && (
        <Field label="For">
          <Select value={shopId} onChange={(e) => setShopId(e.target.value)} className="w-48">
            {shops.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </Field>
      )}
      <Button disabled={pending}>Approve this device{shops.length === 1 ? ` for ${shops[0].name}` : ""}</Button>
      <Saved ok={ok} error={error} />
    </form>
  );
}
