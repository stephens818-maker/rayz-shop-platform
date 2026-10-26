"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Badge, Button, Card, CardHeader, Notice, Table, Td, Th } from "@/components/ui";
import { BULK_FEE_ACTIONS, BULK_FEE_ACTION_LABEL, BulkFeeAction, FEE_APPLY_TO, FEE_APPLY_TO_LABEL, FeeApplyTo, SHOP_FEE_OFF_LABEL, ShopFeeOff } from "@/domain/card-fee-policy";
import { SaveBar, useSave } from "../settings/editors";
import { bulkShopFeeAction, saveFeeShopsAction } from "./actions";

export interface FeeShopRow {
  shopId: string;
  name: string;
  state: string;
  setup: boolean;
  on: boolean;
  off: ShopFeeOff | null;
  fee: string;
  appliesToTip: boolean;
  inherits: boolean;
  ownKeys: string[];
  /** "Oct 26, 2026", or null when it hasn't changed since the surcharge policy began. */
  changed: string | null;
}

const OWN_LABEL: Record<string, string> = {
  enabled: "on/off",
  type: "fee type",
  rate: "rate",
  flatCents: "flat amount",
  appliesToTip: "tips",
  capCents: "cap",
  minCents: "minimum",
  notice: "notice",
  channels: "channels",
  funding: "wallets",
};

const APPLY_HINT: Record<FeeApplyTo, string> = {
  all: "Every shop, including locations added later.",
  selected: "Only the shops ticked below. A new location starts without it until it's ticked.",
  none: "No shop adds the surcharge.",
};

/** Which shops use the brand's surcharge, and whether shop managers may change their own shop's. */
export function FeeShopsCard({ initial, shops }: { initial: { appliesTo: FeeApplyTo; shopIds: string[]; shopsCanEdit: boolean }; shops: { id: string; name: string; state: string }[] }) {
  const { pending, msg, save } = useSave();
  const [appliesTo, setAppliesTo] = useState(initial.appliesTo);
  const [ticked, setTicked] = useState(() => new Set(initial.appliesTo === "selected" ? initial.shopIds : shops.map((s) => s.id)));
  const [canEdit, setCanEdit] = useState(initial.shopsCanEdit);
  const push = useBulk();
  const saved = appliesTo === initial.appliesTo && (appliesTo !== "selected" || JSON.stringify([...ticked].sort()) === JSON.stringify([...initial.shopIds].sort()));
  const toggle = (id: string, on: boolean) => {
    const n = new Set(ticked);
    if (on) n.add(id);
    else n.delete(id);
    setTicked(n);
  };
  return (
    <Card>
      <CardHeader title="Apply to shops" subtitle="Which shops use the brand's surcharge. A shop it doesn't apply to charges none, whatever its own setting. Every change is in the audit log." />
      <div className="space-y-4 p-4">
        <fieldset className="flex flex-wrap gap-4 text-sm">
          {FEE_APPLY_TO.map((a) => (
            <label key={a} className="flex items-center gap-2">
              <input type="radio" name="appliesTo" checked={appliesTo === a} onChange={() => setAppliesTo(a)} /> {FEE_APPLY_TO_LABEL[a]}
            </label>
          ))}
        </fieldset>
        <p className="text-xs text-zinc-500">{APPLY_HINT[appliesTo]}</p>
        {appliesTo === "selected" && (
          <div>
            <div className="mb-1 flex items-center justify-between text-xs font-medium text-zinc-700">
              <span>
                {ticked.size} of {shops.length} shops
              </span>
              <span className="space-x-2 font-normal">
                <button type="button" className="underline" onClick={() => setTicked(new Set(shops.map((s) => s.id)))}>
                  All
                </button>
                <button type="button" className="underline" onClick={() => setTicked(new Set())}>
                  None
                </button>
              </span>
            </div>
            <div className="grid gap-1 text-sm sm:grid-cols-2 lg:grid-cols-3">
              {shops.map((s) => (
                <label key={s.id} className="flex items-center gap-2">
                  <input type="checkbox" checked={ticked.has(s.id)} onChange={(e) => toggle(s.id, e.target.checked)} /> {s.name}
                  {s.state && <span className="text-xs text-zinc-400">{s.state}</span>}
                </label>
              ))}
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <Button
                size="sm"
                variant="secondary"
                disabled={push.pending || ticked.size === 0}
                onClick={() =>
                  confirm(`Push the brand's saved surcharge settings to ${ticked.size} shop${ticked.size === 1 ? "" : "s"}? Their own settings are replaced and the surcharge is applied there.`) &&
                  push.run("push", [...ticked])
                }
              >
                Push brand settings to selected shops
              </Button>
              <span className="text-xs text-zinc-500">Applies the brand&apos;s saved settings to the ticked shops and clears their own, in one step.</span>
              {push.msg && <span className={push.msg.ok ? "text-sm text-emerald-700" : "text-sm text-red-600"}>{push.msg.text}</span>}
            </div>
          </div>
        )}
        <fieldset className="space-y-1 border-t border-zinc-100 pt-3 text-sm">
          <legend className="mb-1 text-xs font-medium text-zinc-700">Shop managers</legend>
          <label className="flex items-center gap-2">
            <input type="radio" name="shopsCanEdit" checked={!canEdit} onChange={() => setCanEdit(false)} /> See their shop&apos;s surcharge only
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" name="shopsCanEdit" checked={canEdit} onChange={() => setCanEdit(true)} /> Can change their own shop&apos;s surcharge
          </label>
          <p className="text-xs text-zinc-500">
            For people who edit a shop&apos;s checkout settings. They can set their shop&apos;s fee, channels and notice within the brand&apos;s limits; which shops use it, waivers, refunds and states stay
            the brand&apos;s.
          </p>
        </fieldset>
      </div>
      <SaveBar pending={pending} msg={msg} onClick={() => save(() => saveFeeShopsAction({ appliesTo, shopIds: appliesTo === "selected" ? [...ticked] : initial.shopIds, shopsCanEdit: canEdit }))} />
      {!saved && <p className="px-4 pb-3 text-xs text-amber-700">Not saved yet. Pushing uses the saved brand settings and adds the ticked shops on its own.</p>}
    </Card>
  );
}

function useBulk() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const run = (action: BulkFeeAction, ids: string[], after?: () => void) =>
    start(async () => {
      const r = await bulkShopFeeAction(action, ids);
      if (r.ok) {
        const n = r.data.changed;
        setMsg({ ok: true, text: `${BULK_FEE_ACTION_LABEL[action]}: ${n ? `${n} shop${n === 1 ? "" : "s"} changed` : "nothing to change"}${r.data.note ? `. ${r.data.note}` : ""}` });
        after?.();
      } else setMsg({ ok: false, text: r.error });
      router.refresh();
    });
  return { pending, msg, run };
}

const CONFIRM: Partial<Record<BulkFeeAction, string>> = {
  reset: "Clear these shops' own surcharge settings so they follow the brand?",
  push: "Replace these shops' own settings with the brand's and apply the surcharge there?",
  disable: "Stop applying the surcharge at these shops? Their own settings are kept.",
};

/** Every shop's surcharge as it stands, with bulk actions on the ticked ones. */
export function ShopFeeTable({ rows }: { rows: FeeShopRow[] }) {
  const [picked, setPicked] = useState(new Set<string>());
  const bulk = useBulk();
  const all = rows.length > 0 && picked.size === rows.length;
  const act = (a: BulkFeeAction) => {
    const n = picked.size;
    if (CONFIRM[a] && !confirm(`${CONFIRM[a]} (${n} shop${n === 1 ? "" : "s"})`)) return;
    bulk.run(a, [...picked], () => setPicked(new Set()));
  };
  const on = rows.filter((r) => r.on).length;
  return (
    <Card>
      <CardHeader title="Shops" subtitle={`${on} of ${rows.length} shops add the surcharge. Tick shops to change them together; each change is audited with the old and new values.`} />
      <div className="flex flex-wrap items-center gap-2 border-b border-zinc-100 px-4 py-3">
        <span className="text-sm text-zinc-600">{picked.size ? `${picked.size} selected` : "Select shops to"}</span>
        {BULK_FEE_ACTIONS.filter((a) => a !== "push").map((a) => (
          <Button key={a} size="sm" variant={a === "enable" ? "primary" : "secondary"} disabled={bulk.pending || picked.size === 0} onClick={() => act(a)}>
            {BULK_FEE_ACTION_LABEL[a]}
          </Button>
        ))}
        <Button size="sm" variant="secondary" disabled={bulk.pending || picked.size === 0} onClick={() => act("push")}>
          {BULK_FEE_ACTION_LABEL.push}
        </Button>
        {bulk.msg && <span className={bulk.msg.ok ? "text-sm text-emerald-700" : "text-sm text-red-600"}>{bulk.msg.text}</span>}
      </div>
      <Table>
        <thead>
          <tr>
            <Th className="w-8">
              <input type="checkbox" aria-label="Select every shop" checked={all} onChange={(e) => setPicked(e.target.checked ? new Set(rows.map((r) => r.shopId)) : new Set())} />
            </Th>
            <Th>Shop</Th>
            <Th>State</Th>
            <Th>Surcharge</Th>
            <Th right>Rate</Th>
            <Th>Setting</Th>
            <Th>Last changed</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.shopId}>
              <Td>
                <input
                  type="checkbox"
                  aria-label={`Select ${r.name}`}
                  checked={picked.has(r.shopId)}
                  onChange={(e) => {
                    const n = new Set(picked);
                    if (e.target.checked) n.add(r.shopId);
                    else n.delete(r.shopId);
                    setPicked(n);
                  }}
                />
              </Td>
              <Td className="font-medium">
                <Link href={`/admin/settings?shop=${r.shopId}`} className="hover:underline">
                  {r.name}
                </Link>
                {r.setup && (
                  <Badge className="ml-2" tone="violet">
                    Setting up
                  </Badge>
                )}
              </Td>
              <Td>{r.state || "—"}</Td>
              <Td>
                {r.on ? (
                  <Badge tone="green">On</Badge>
                ) : (
                  <span className="flex items-center gap-2">
                    <Badge>Off</Badge>
                    <span className="text-xs text-zinc-500">{r.off ? SHOP_FEE_OFF_LABEL[r.off] : ""}</span>
                  </span>
                )}
              </Td>
              <Td right>
                {r.fee}
                {r.appliesToTip && <span className="ml-1 text-xs text-zinc-500">incl. tips</span>}
              </Td>
              <Td>{r.inherits ? <Badge tone="blue">Brand</Badge> : <span title={r.ownKeys.map((k) => OWN_LABEL[k] ?? k).join(", ")}><Badge tone="amber">Own</Badge> <span className="text-xs text-zinc-500">{r.ownKeys.map((k) => OWN_LABEL[k] ?? k).join(", ")}</span></span>}</Td>
              <Td className="text-zinc-600">{r.changed ?? "—"}</Td>
            </tr>
          ))}
        </tbody>
      </Table>
      <div className="space-y-1 px-4 py-3 text-xs text-zinc-500">
        <p>
          <b>Enable</b> applies the surcharge at the shop and turns its own &ldquo;off&rdquo; back on. <b>Disable</b> stops applying it there and keeps the shop&apos;s own settings. <b>Apply brand rate</b>{" "}
          drops the shop&apos;s own fee type and rate. <b>Reset to brand default</b> drops all its own settings. <b>Push brand settings</b> does both: resets the shop and applies the surcharge there.
        </p>
        <p>The rate is after any state limit. Last changed is when what the shop charges last changed, including brand changes that reached it.</p>
      </div>
      {rows.some((r) => r.off === "state_not_allowed") && (
        <div className="px-4 pb-4">
          <Notice>Shops in a state the brand doesn&apos;t surcharge in stay off whatever is applied. The state list is in the brand settings below.</Notice>
        </div>
      )}
    </Card>
  );
}
