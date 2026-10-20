"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button, Field, Input, Notice, Select } from "@/components/ui";
import { createPromoAction, issueGiftCardAction, togglePromoAction, voidGiftCardAction } from "./actions";

export function PromoToggle({ id, active }: { id: string; active: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <button className="text-xs underline" disabled={pending} onClick={() => start(async () => (await togglePromoAction(id, !active), router.refresh()))}>
      {active ? "Turn off" : "Turn on"}
    </button>
  );
}

export function PromoForm({ shops, isAdmin }: { shops: { id: string; name: string }[]; isAdmin: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [v, setV] = useState({ code: "", description: "", type: "percent" as "percent" | "amount", value: "", appliesTo: "services" as "services" | "products" | "all", shopId: isAdmin ? "" : (shops[0]?.id ?? ""), startsOn: "", endsOn: "", max: "" });
  return (
    <div className="border-t border-zinc-100 p-4">
      <div className="mb-2 text-sm font-semibold">New promo</div>
      <div className="grid gap-3 sm:grid-cols-4 lg:grid-cols-8">
        <Field label="Code" className="lg:col-span-1">
          <Input className="uppercase" value={v.code} onChange={(e) => setV({ ...v, code: e.target.value.toUpperCase() })} />
        </Field>
        <Field label="Type">
          <Select value={v.type} onChange={(e) => setV({ ...v, type: e.target.value as "percent" | "amount" })}>
            <option value="percent">% off</option>
            <option value="amount">$ off</option>
          </Select>
        </Field>
        <Field label={v.type === "percent" ? "Percent" : "Dollars"}>
          <Input inputMode="decimal" value={v.value} onChange={(e) => setV({ ...v, value: e.target.value })} />
        </Field>
        <Field label="On">
          <Select value={v.appliesTo} onChange={(e) => setV({ ...v, appliesTo: e.target.value as typeof v.appliesTo })}>
            <option value="services">Services</option>
            <option value="products">Products</option>
            <option value="all">Everything</option>
          </Select>
        </Field>
        <Field label="Shop">
          <Select value={v.shopId} onChange={(e) => setV({ ...v, shopId: e.target.value })}>
            {isAdmin && <option value="">All shops</option>}
            {shops.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Starts">
          <Input type="date" value={v.startsOn} onChange={(e) => setV({ ...v, startsOn: e.target.value })} />
        </Field>
        <Field label="Ends">
          <Input type="date" value={v.endsOn} onChange={(e) => setV({ ...v, endsOn: e.target.value })} />
        </Field>
        <Field label="Max uses">
          <Input inputMode="numeric" value={v.max} onChange={(e) => setV({ ...v, max: e.target.value })} />
        </Field>
        <Field label="Description" className="sm:col-span-3 lg:col-span-7">
          <Input value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} />
        </Field>
        <div className="flex items-end">
          <Button
            className="w-full"
            disabled={pending || !v.code || !v.value}
            onClick={() =>
              start(async () => {
                const r = await createPromoAction({
                  code: v.code,
                  description: v.description || null,
                  type: v.type,
                  value: v.type === "percent" ? Math.round(Number(v.value)) : Math.round(Number(v.value) * 100),
                  appliesTo: v.appliesTo,
                  shopId: v.shopId || null,
                  startsOn: v.startsOn || null,
                  endsOn: v.endsOn || null,
                  maxRedemptions: v.max ? Number(v.max) : null,
                });
                setError(r.ok ? null : r.error);
                if (r.ok) setV({ ...v, code: "", value: "", description: "" });
                router.refresh();
              })
            }
          >
            Create
          </Button>
        </div>
      </div>
      {error && (
        <div className="mt-2">
          <Notice tone="red">{error}</Notice>
        </div>
      )}
    </div>
  );
}

export function GiftCardTools({ shopId, initialQuery }: { shopId: string; initialQuery: string }) {
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
      <div className="flex flex-wrap items-end gap-2">
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
