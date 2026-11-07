"use client";

import { useState } from "react";
import { ItemPicker, Chips, toggle } from "@/components/chips";
import { Button, Field, Input, Notice, Select } from "@/components/ui";
import { SyncMsg, useSettingSync } from "@/components/brand-sync";
import { useAction } from "@/components/use-action";
import type { PlanInput } from "@/domain/memberships";
import { parseDollars } from "@/lib/money";
import { searchCustomersAction } from "../calendar/actions";
import { cancelMembershipAction, enrollAction, keepMembershipAction, savePlanAction } from "./actions";

type Option = { id: string; name: string };

export function MembershipsSwitch({ on }: { on: boolean }) {
  const { pending, msg, saveSetting, dialog } = useSettingSync("memberships", on ? "Turn memberships off" : "Turn memberships on");
  return (
    <div className="flex items-center gap-3">
      <Button size="sm" variant={on ? "secondary" : "primary"} disabled={pending} onClick={() => saveSetting(!on)}>
        {on ? "Turn memberships off" : "Turn memberships on"}
      </Button>
      <SyncMsg msg={msg} />
      {dialog}
    </div>
  );
}

type PlanForm = { name: string; description: string; price: string; serviceIds: string[]; visits: string; productDiscountPct: string; shopIds: string[]; active: boolean };
const blank: PlanForm = { name: "", description: "", price: "", serviceIds: [], visits: "", productDiscountPct: "0", shopIds: [], active: true };

export function PlanEditor({ plan, services, shops, onDone }: { plan: (PlanInput & { id: string }) | null; services: Option[]; shops: Option[]; onDone?: () => void }) {
  const [v, setV] = useState<PlanForm>(
    plan
      ? {
          name: plan.name,
          description: plan.description ?? "",
          price: (plan.priceCents / 100).toFixed(2),
          serviceIds: plan.serviceIds,
          visits: plan.visitsPerPeriod == null ? "" : String(plan.visitsPerPeriod),
          productDiscountPct: String(plan.productDiscountPct),
          shopIds: plan.shopIds,
          active: plan.active,
        }
      : blank,
  );
  const { pending, error, run } = useAction();
  const save = () =>
    run(
      () =>
        savePlanAction(plan?.id ?? null, {
          name: v.name,
          description: v.description,
          priceCents: parseDollars(v.price) || 0,
          serviceIds: v.serviceIds,
          visitsPerPeriod: v.visits.trim() ? Number(v.visits) : null,
          productDiscountPct: Number(v.productDiscountPct) || 0,
          shopIds: v.shopIds,
          active: v.active,
        }),
      () => {
        if (!plan) setV(blank);
        onDone?.();
      },
    );
  return (
    <div className="space-y-3 p-4">
      <div className="grid gap-3 sm:grid-cols-[1fr_8rem_10rem_8rem]">
        <Field label="Plan name">
          <Input value={v.name} maxLength={60} onChange={(e) => setV({ ...v, name: e.target.value })} placeholder="Buzz Club" />
        </Field>
        <Field label="Monthly price $">
          <Input inputMode="decimal" value={v.price} onChange={(e) => setV({ ...v, price: e.target.value })} placeholder="39.00" />
        </Field>
        <Field label="Covered visits a month" hint="Blank is unlimited">
          <Input inputMode="numeric" value={v.visits} onChange={(e) => setV({ ...v, visits: e.target.value.replace(/\D/g, "") })} placeholder="Unlimited" />
        </Field>
        <Field label="Retail discount %">
          <Input inputMode="numeric" value={v.productDiscountPct} onChange={(e) => setV({ ...v, productDiscountPct: e.target.value.replace(/\D/g, "") })} />
        </Field>
      </div>
      <Field label="What a visit covers in full">
        <ItemPicker options={services} selected={v.serviceIds} onChange={(serviceIds) => setV({ ...v, serviceIds })} placeholder="Add a service" />
      </Field>
      <Field label="Sold and honored at" hint={v.shopIds.length ? undefined : "Every shop"}>
        <Chips options={shops} selected={v.shopIds} onToggle={(id) => setV({ ...v, shopIds: toggle(v.shopIds, id) })} />
      </Field>
      <Field label="Description (shown to staff when signing someone up)">
        <Input value={v.description} maxLength={300} onChange={(e) => setV({ ...v, description: e.target.value })} />
      </Field>
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={v.active} onChange={(e) => setV({ ...v, active: e.target.checked })} /> Open for sign-ups
        </label>
        <Button disabled={pending} onClick={save}>
          {plan ? "Save plan" : "Add plan"}
        </Button>
        {onDone && (
          <Button variant="ghost" onClick={onDone}>
            Cancel
          </Button>
        )}
        <span className="text-xs text-zinc-500">A new price applies to new members; existing members keep what they signed up at.</span>
      </div>
      {error && <Notice tone="red">{error}</Notice>}
    </div>
  );
}

export function PlanRow({ plan, services, shops, children }: { plan: PlanInput & { id: string }; services: Option[]; shops: Option[]; children: React.ReactNode }) {
  const [editing, setEditing] = useState(false);
  if (editing) return <PlanEditor plan={plan} services={services} shops={shops} onDone={() => setEditing(false)} />;
  return (
    <div className="flex items-start justify-between gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">{children}</div>
      <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
        Edit
      </Button>
    </div>
  );
}

export function EnrollForm({ plans, shops, defaultShopId }: { plans: { id: string; name: string; priceCents: number; shopIds: string[] }[]; shops: Option[]; defaultShopId: string | null }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<{ id: string; name: string; phone: string | null }[]>([]);
  const [client, setClient] = useState<{ id: string; name: string } | null>(null);
  const [planId, setPlanId] = useState(plans[0]?.id ?? "");
  const [shopId, setShopId] = useState(defaultShopId ?? shops[0]?.id ?? "");
  const [done, setDone] = useState<{ name: string; url: string | null } | null>(null);
  const search = useAction();
  const { pending, error, run } = useAction();
  const sold = plans.filter((p) => !p.shopIds.length || p.shopIds.includes(shopId));
  return (
    <div className="space-y-3 p-4">
      <div className="grid gap-3 md:grid-cols-[1fr_14rem_12rem]">
        <Field label="Client">
          {client ? (
            <div className="flex items-center gap-2 text-sm">
              <span className="font-medium">{client.name}</span>
              <button type="button" className="text-xs underline" onClick={() => setClient(null)}>
                Change
              </button>
            </div>
          ) : (
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                search.run(
                  () => searchCustomersAction(q, "pos"),
                  (r) => setHits(r.map((h) => ({ id: h.id, name: `${h.firstName} ${h.lastName ?? ""}`.trim(), phone: h.phone }))),
                );
              }}
            >
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name or phone" />
              <Button type="submit" variant="secondary" disabled={search.pending || q.trim().length < 2}>
                Find
              </Button>
            </form>
          )}
        </Field>
        <Field label="Home shop">
          <Select value={shopId} onChange={(e) => setShopId(e.target.value)}>
            {shops.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Plan">
          <Select value={sold.some((p) => p.id === planId) ? planId : (sold[0]?.id ?? "")} onChange={(e) => setPlanId(e.target.value)}>
            {sold.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} · ${(p.priceCents / 100).toFixed(2)}/mo
              </option>
            ))}
          </Select>
        </Field>
      </div>
      {!client && hits.length > 0 && (
        <ul className="divide-y divide-zinc-100 rounded-lg ring-1 ring-zinc-200">
          {hits.slice(0, 8).map((h) => (
            <li key={h.id}>
              <button type="button" className="flex w-full justify-between px-3 py-2 text-left text-sm hover:bg-zinc-50" onClick={() => (setClient({ id: h.id, name: h.name }), setHits([]))}>
                <span>{h.name}</span>
                <span className="text-xs text-zinc-500">{h.phone ?? ""}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-3">
        <Button
          disabled={pending || !client || !sold.length}
          onClick={() =>
            run(
              () => enrollAction({ planId: sold.some((p) => p.id === planId) ? planId : sold[0].id, customerId: client!.id, homeShopId: shopId }),
              (r) => {
                setDone({ name: client!.name, url: r.checkoutUrl });
                setClient(null);
                setQ("");
              },
            )
          }
        >
          Sign up
        </Button>
        {!sold.length && <span className="text-xs text-zinc-500">No plan is sold at this shop.</span>}
      </div>
      {done &&
        (done.url ? (
          <Notice tone="blue">
            {done.name} pays the first month on Stripe&apos;s secure page: <a className="break-all underline" href={done.url} target="_blank" rel="noreferrer">{done.url}</a>. The membership turns on when it&apos;s paid.
          </Notice>
        ) : (
          <Notice tone="green">{done.name} is signed up. The first month is recorded and it renews monthly.</Notice>
        ))}
      {(error || search.error) && <Notice tone="red">{error ?? search.error}</Notice>}
    </div>
  );
}

export function MemberActions({ id, cancelAtPeriodEnd, status }: { id: string; cancelAtPeriodEnd: boolean; status: string }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const { pending, error, run } = useAction();
  if (status === "canceled") return null;
  if (cancelAtPeriodEnd)
    return (
      <span className="flex items-center gap-2">
        <button type="button" className="text-xs underline" disabled={pending} onClick={() => run(() => keepMembershipAction(id))}>
          Keep it going
        </button>
        {error && <span className="text-xs text-red-600">{error}</span>}
      </span>
    );
  if (!open)
    return (
      <button type="button" className="text-xs text-red-700 underline" onClick={() => setOpen(true)}>
        Cancel
      </button>
    );
  return (
    <div className="w-60 space-y-1.5">
      <Input className="py-1" placeholder="Reason" maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Cancel reason" />
      <div className="flex flex-wrap gap-1.5">
        {status !== "incomplete" && (
          <Button size="sm" variant="secondary" disabled={pending} onClick={() => run(() => cancelMembershipAction({ id, when: "period_end", reason }), () => setOpen(false))}>
            At month end
          </Button>
        )}
        <Button size="sm" variant="danger" disabled={pending} onClick={() => run(() => cancelMembershipAction({ id, when: "now", reason }), () => setOpen(false))}>
          Now
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Back
        </Button>
      </div>
      {error && <div className="text-xs text-red-600">{error}</div>}
    </div>
  );
}
