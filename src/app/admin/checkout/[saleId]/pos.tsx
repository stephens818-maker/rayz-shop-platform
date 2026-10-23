"use client";

import { useRouter } from "next/navigation";
import { type ChangeEvent, type FormEvent, useEffect, useMemo, useState, useTransition } from "react";
import { Badge, Button, Card, CardHeader, Input, Notice, Select, StarBadge, Suggestions, cx } from "@/components/ui";
import type { RatingSummary } from "@/domain/ratings";
import { CardFeeConfig, CardFunding, Discount, LineKind, TaxCategory, TaxRates, computeCheckout, feeLabel, manualDiscountProblem, tipSuggestions } from "@/domain/checkout";
import { formatMinutes, type TimesView } from "@/domain/service-times";
import { searchCustomersAction } from "../../calendar/actions";
import { ServiceTimer } from "../../calendar/service-times-panel";
import { attachCustomerAction, finalizeAction, giftCardAction, holdRetailAction, inspectCardAction, newClientAtCheckoutAction, promoAction, setBarberAction, terminalCollectAction } from "../actions";
import { StripeCardEntry } from "./stripe-card";

type Line = { key: string; kind: LineKind; refId: string | null; name: string; unitPriceCents: number; qty: number; override?: { unitPriceCents: number; reason: string } | null };
type Card4 = { paymentMethodId: string; funding: CardFunding; brand: string; last4: string };

const $ = (c: number) => `${c < 0 ? "-" : ""}$${(Math.abs(c) / 100).toFixed(2)}`;
const $short = (c: number) => `$${(c / 100).toFixed(c % 100 ? 2 : 0)}`;
const toCents = (s: string) => {
  const n = Number(s.replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};
let seq = 0;
const key = () => `l${++seq}`;

export function Pos(props: {
  sale: { id: string; number: number; staffId: string | null; hasAppointment: boolean };
  timer: { appointmentId: string; status: string; times: TimesView | null } | null;
  shop: { id: string; name: string; taxVerified: boolean };
  config: { taxRates: TaxRates; cardFee: CardFeeConfig; tipPresets: number[] };
  feeNotice: string | null;
  initialLines: Omit<Line, "key">[];
  customer: { id: string; name: string; phone: string | null; notes: string | null; rating: RatingSummary | null } | null;
  barber: { id: string; label: string } | null;
  barbers: { id: string; label: string }[];
  services: { id: string; name: string; kind: "service" | "addon"; priceCents: number }[];
  retail: { productId: string; name: string; brand: string; priceCents: number; stock: number; available: number }[];
  negativeStock: "block" | "warn";
  loyalty: { rewards: { id: string; amountCents: number; expiresAt: string | null }[]; progressCents: number; thresholdCents: number; redeemableOn: "services" | "all" } | null;
  payments: { mode: "stripe" | "simulator"; publishableKey: string | null; terminalLabel: string; testCards: { id: string; label: string; funding: string }[] };
  taxCategories: Record<string, TaxCategory>;
  perms: { discount: boolean; maxDiscountPct: number; priceOverride: boolean; reassign: boolean };
  canAdd: { phone: boolean; email: boolean };
  reasons?: { discount: string[]; priceChange: string[] };
}) {
  const router = useRouter();
  const [lines, setLines] = useState<Line[]>(() => props.initialLines.map((l) => ({ ...l, key: key() })));
  const [promo, setPromo] = useState<(Discount & { code: string }) | null>(null);
  const [promoInput, setPromoInput] = useState("");
  const [manual, setManual] = useState<{ type: "percent" | "amount"; value: string; reason: string }>({ type: "percent", value: "", reason: "" });
  const [rewardId, setRewardId] = useState<string | null>(null);
  const [tipCents, setTipCents] = useState(0);
  const [tipMode, setTipMode] = useState<string>("none");
  const [customTip, setCustomTip] = useState("");
  const [giftInput, setGiftInput] = useState("");
  const [gift, setGift] = useState<{ code: string; balanceCents: number } | null>(null);
  const [tender, setTender] = useState<"cash" | "card" | null>(null);
  const [cardMode, setCardMode] = useState<"terminal" | "keyed">("terminal");
  const [card, setCard] = useState<Card4 | null>(null);
  const [cashTendered, setCashTendered] = useState<number | null>(null);
  const [rebookWeeks, setRebookWeeks] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [productQ, setProductQ] = useState("");
  const [giftSale, setGiftSale] = useState("");
  const [editing, setEditing] = useState<{ key: string; price: string; reason: string } | null>(null);
  const priceOf = (l: Line) => l.override?.unitPriceCents ?? l.unitPriceCents;

  const reward = props.loyalty?.rewards.find((r) => r.id === rewardId) ?? null;
  const discounts = useMemo(() => {
    const d: Discount[] = [];
    if (promo) d.push(promo);
    const mv = manual.type === "percent" ? Number(manual.value) || 0 : toCents(manual.value);
    if (mv > 0) d.push({ source: "manual", label: `Discount: ${manual.reason || "manager"}`, type: manual.type, value: mv, appliesTo: "all" });
    if (reward) d.push({ source: "loyalty", label: "Loyalty reward", type: "amount", value: reward.amountCents, appliesTo: props.loyalty!.redeemableOn === "services" ? "services" : "all" });
    return d;
  }, [promo, manual, reward, props.loyalty]);

  const priced = lines.map((l) => ({ ...l, unitPriceCents: priceOf(l), taxCategory: l.refId ? props.taxCategories[l.refId] : undefined }));
  const manualValue = manual.type === "percent" ? Number(manual.value) || 0 : toCents(manual.value);
  const discountProblem = props.perms.discount ? manualDiscountProblem({ type: manual.type, value: manualValue }, priced, props.perms.maxDiscountPct) : null;
  const preview = (method: "cash" | "card" | "none", funding: CardFunding | null) =>
    computeCheckout({
      lines: priced,
      discounts,
      taxRates: props.config.taxRates,
      tipCents,
      cardFee: props.config.cardFee,
      tender: { method, cardFunding: funding, giftCardCents: gift?.balanceCents ?? 0, giftCardBalanceCents: gift?.balanceCents ?? 0 },
    });
  const base = preview("none", null);
  const method: "cash" | "card" | "none" = base.primaryBaseCents === 0 ? "none" : (tender ?? "none");
  const totals = preview(method, method === "card" ? (card?.funding ?? null) : null);
  const creditPreview = preview("card", "credit");
  const tips = tipSuggestions(base.serviceGrossCents, props.config.tipPresets);

  useEffect(() => setCashTendered(null), [totals.primaryChargeCents]);

  const setLineQty = (k: string, qty: number) => setLines((ls) => (qty <= 0 ? ls.filter((l) => l.key !== k) : ls.map((l) => (l.key === k ? { ...l, qty } : l))));
  const addProduct = (p: (typeof props.retail)[number]) =>
    setLines((ls) => {
      const ex = ls.find((l) => l.kind === "product" && l.refId === p.productId);
      if (ex) return ls.map((l) => (l === ex ? { ...l, qty: l.qty + 1 } : l));
      return [...ls, { key: key(), kind: "product", refId: p.productId, name: `${p.brand} ${p.name}`, unitPriceCents: p.priceCents, qty: 1 }];
    });

  const act = <T,>(fn: () => Promise<{ ok: true; data: T } | { ok: false; error: string }>, ok: (d: T) => void) =>
    start(async () => {
      setError(null);
      const r = await fn();
      if (r.ok) ok(r.data);
      else setError(r.error);
    });

  const pickTip = (mode: string, cents: number) => {
    setTipMode(mode);
    setTipCents(cents);
  };

  const charge = () =>
    act(
      () =>
        finalizeAction({
          saleId: props.sale.id,
          lines: lines.map(({ kind, refId, name, unitPriceCents, qty, override }) => ({ kind, refId, name, unitPriceCents, qty, priceOverride: override ?? null })),
          promoCode: promo?.code ?? null,
          manualDiscount: manual.value ? { type: manual.type, value: manual.type === "percent" ? Number(manual.value) || 0 : toCents(manual.value), reason: manual.reason } : null,
          loyaltyRewardId: rewardId,
          tipCents,
          giftCard: gift ? { code: gift.code, amountCents: gift.balanceCents } : null,
          tender:
            method === "cash"
              ? { method: "cash", cashTenderedCents: cashTendered }
              : method === "card"
                ? { method: "card", paymentMethodId: card!.paymentMethodId, entryMode: cardMode }
                : { method: "none" },
          expectedTotalCents: totals.totalCents,
          rebookInWeeks: rebookWeeks,
        }),
      (d) => {
        const q = new URLSearchParams({ done: "1" });
        if (d.rebook && "code" in d.rebook && d.rebook.code) q.set("rebook", d.rebook.code);
        if (d.rebook && "error" in d.rebook && d.rebook.error) q.set("rebookError", d.rebook.error);
        if (d.rewardsIssued) q.set("rewards", String(d.rewardsIssued));
        if (d.stockWarnings.length) q.set("stock", d.stockWarnings.join("\n"));
        router.push(`/admin/sales/${d.saleId}?${q}`);
      },
    );

  const ready = lines.length > 0 && (method === "none" || method === "cash" || (method === "card" && !!card));
  const change = cashTendered != null ? cashTendered - totals.primaryChargeCents : 0;
  // Retail on the ticket is held (counts as committed) while the ticket is open.
  const held = lines
    .filter((l) => l.kind === "product" && l.refId)
    .map((l) => `${l.refId}:${l.qty}`)
    .sort()
    .join(",");
  const [savedHold, setSavedHold] = useState(() => held);
  useEffect(() => {
    if (held === savedHold) return;
    const t = setTimeout(() => {
      const list = held ? held.split(",").map((x) => ({ productId: x.split(":")[0], qty: Number(x.split(":")[1]) })) : [];
      holdRetailAction(props.sale.id, list).then((r) => r.ok && setSavedHold(held));
    }, 600);
    return () => clearTimeout(t);
  }, [held, savedHold, props.sale.id]);
  const onTicket = (productId: string) => lines.filter((l) => l.kind === "product" && l.refId === productId).reduce((a, l) => a + l.qty, 0);
  const short = props.retail.filter((p) => onTicket(p.productId) > p.available);
  const filteredRetail = props.retail.filter((p) => !productQ || `${p.brand} ${p.name}`.toLowerCase().includes(productQ.toLowerCase())).slice(0, 12);

  return (
    <div className="mx-auto max-w-6xl">
      <Suggestions id="discount-reasons" items={props.reasons?.discount ?? []} />
      <Suggestions id="price-reasons" items={props.reasons?.priceChange ?? []} />
      <div className="mb-4 flex flex-wrap items-end justify-between gap-2">
        <div>
          <div className="text-xs font-medium uppercase tracking-wide text-zinc-500">
            {props.shop.name} · Ticket #{props.sale.number}
          </div>
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Checkout</h1>
        </div>
        <Badge tone={props.payments.mode === "stripe" ? "violet" : "gray"}>{props.payments.mode === "stripe" ? "Stripe test mode" : "Payment simulator (no Stripe keys)"}</Badge>
      </div>
      {!props.shop.taxVerified && (
        <div className="mb-3">
          <Notice>Tax rates for {props.shop.name} are placeholders until verified in Shop settings.</Notice>
        </div>
      )}
      <div className="grid gap-4 lg:grid-cols-[1fr_400px]">
        {/* Ticket */}
        <div className="space-y-4">
          <Card>
            <div className="grid gap-3 p-4 sm:grid-cols-2">
              <CustomerBox saleId={props.sale.id} customer={props.customer} canAdd={props.canAdd} onError={setError} />
              <div>
                <div className="mb-1 text-xs font-medium text-zinc-700">Barber (gets service credit + tip)</div>
                <Select
                  value={props.sale.staffId ?? ""}
                  disabled={!props.perms.reassign}
                  onChange={(e) => act(() => setBarberAction(props.sale.id, e.target.value || null), () => router.refresh())}
                >
                  <option value="">Unassigned</option>
                  {props.barbers.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.label}
                    </option>
                  ))}
                  {props.barber && !props.barbers.some((b) => b.id === props.barber!.id) && <option value={props.barber.id}>{props.barber.label}</option>}
                </Select>
              </div>
            </div>
          </Card>

          <Card>
            <CardHeader title="Items" />
            <ul className="divide-y divide-zinc-100">
              {lines.length === 0 && <li className="px-4 py-6 text-center text-sm text-zinc-500">Add a service, product or gift card below.</li>}
              {lines.map((l) => (
                <li key={l.key} className="flex items-center gap-3 px-4 py-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{l.name}</div>
                    <div className="text-xs capitalize text-zinc-500">
                      {l.kind.replace("_", " ")}
                      {l.override && <span className="normal-case text-amber-700"> · price changed: {l.override.reason}</span>}
                    </div>
                  </div>
                  {l.kind === "product" ? (
                    <div className="flex items-center rounded-lg ring-1 ring-zinc-300">
                      <button className="h-8 w-8 text-lg" onClick={() => setLineQty(l.key, l.qty - 1)} aria-label="Less">
                        −
                      </button>
                      <span className="w-6 text-center text-sm tabular">{l.qty}</span>
                      <button className="h-8 w-8 text-lg" onClick={() => setLineQty(l.key, l.qty + 1)} aria-label="More">
                        +
                      </button>
                    </div>
                  ) : (
                    <button className="text-xs text-zinc-400 hover:text-red-600" onClick={() => setLineQty(l.key, 0)}>
                      Remove
                    </button>
                  )}
                  {props.perms.priceOverride && l.kind !== "gift_card" ? (
                    <button
                      className={cx("w-20 text-right text-sm tabular underline decoration-dotted underline-offset-2", l.override && "text-amber-700")}
                      title="Change price"
                      onClick={() => setEditing({ key: l.key, price: (priceOf(l) / 100).toFixed(2), reason: l.override?.reason ?? "" })}
                    >
                      {$(priceOf(l) * l.qty)}
                    </button>
                  ) : (
                    <div className="w-20 text-right text-sm tabular">{$(priceOf(l) * l.qty)}</div>
                  )}
                </li>
              ))}
              {editing && (
                <li className="space-y-2 bg-amber-50 px-4 py-3">
                  <div className="text-xs font-medium text-amber-900">
                    Change price for {lines.find((l) => l.key === editing.key)?.name} (menu {$(lines.find((l) => l.key === editing.key)?.unitPriceCents ?? 0)}). Logged with your name.
                  </div>
                  <div className="grid grid-cols-[100px_1fr_auto_auto] gap-2">
                    <Input inputMode="decimal" value={editing.price} onChange={(e) => setEditing({ ...editing, price: e.target.value })} aria-label="New unit price" />
                    <Input list="price-reasons" placeholder="Reason (required)" value={editing.reason} onChange={(e) => setEditing({ ...editing, reason: e.target.value })} />
                    <Button
                      size="sm"
                      disabled={!editing.reason.trim()}
                      onClick={() => {
                        const cents = toCents(editing.price);
                        setLines((ls) => ls.map((l) => (l.key === editing.key ? { ...l, override: cents === l.unitPriceCents ? null : { unitPriceCents: cents, reason: editing.reason.trim() } } : l)));
                        setEditing(null);
                      }}
                    >
                      Save
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        setLines((ls) => ls.map((l) => (l.key === editing.key ? { ...l, override: null } : l)));
                        setEditing(null);
                      }}
                    >
                      Menu price
                    </Button>
                  </div>
                </li>
              )}
            </ul>
            <div className="grid gap-3 border-t border-zinc-100 p-4 sm:grid-cols-2">
              <div>
                <div className="mb-1 text-xs font-medium text-zinc-700">Add service</div>
                <Select
                  value=""
                  onChange={(e) => {
                    const s = props.services.find((x) => x.id === e.target.value);
                    if (s) setLines((ls) => [...ls, { key: key(), kind: s.kind, refId: s.id, name: s.name, unitPriceCents: s.priceCents, qty: 1 }]);
                  }}
                >
                  <option value="">Choose…</option>
                  {props.services.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.kind === "addon" ? "+ " : ""}
                      {s.name} · {$short(s.priceCents)}
                    </option>
                  ))}
                </Select>
              </div>
              <div>
                <div className="mb-1 text-xs font-medium text-zinc-700">Sell a gift card</div>
                <div className="flex gap-2">
                  <Input placeholder="$ amount" inputMode="decimal" value={giftSale} onChange={(e) => setGiftSale(e.target.value)} />
                  <Button
                    variant="secondary"
                    onClick={() => {
                      const c = toCents(giftSale);
                      if (c < 500 || c > 50_000) return setError("Gift cards are sold from $5 to $500");
                      setLines((ls) => [...ls, { key: key(), kind: "gift_card", refId: null, name: `Gift card ${$short(c)}`, unitPriceCents: c, qty: 1 }]);
                      setGiftSale("");
                    }}
                  >
                    Add
                  </Button>
                </div>
              </div>
            </div>
            <div className="border-t border-zinc-100 p-4">
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="text-xs font-medium text-zinc-700">Retail</div>
                <Input className="max-w-48 py-1" placeholder="Search products" value={productQ} onChange={(e) => setProductQ(e.target.value)} />
              </div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {filteredRetail.map((p) => (
                  <button key={p.productId} onClick={() => addProduct(p)} className="rounded-lg px-2.5 py-2 text-left ring-1 ring-zinc-200 hover:bg-zinc-50 hover:ring-zinc-300">
                    <div className="truncate text-xs text-zinc-500">{p.brand}</div>
                    <div className="truncate text-sm font-medium">{p.name}</div>
                    <div className="mt-0.5 flex justify-between text-xs">
                      <span className="tabular">{$short(p.priceCents)}</span>
                      <span className={p.available - onTicket(p.productId) <= 0 ? "text-red-600" : "text-zinc-400"}>{Math.max(0, p.available - onTicket(p.productId))} left</span>
                    </div>
                  </button>
                ))}
              </div>
              {short.length > 0 && (
                <div className={cx("mt-2 rounded-md px-3 py-2 text-xs", props.negativeStock === "block" ? "bg-red-50 text-red-700" : "bg-amber-50 text-amber-800")}>
                  {short.map((p) => `${p.brand} ${p.name}: ${Math.max(0, p.available)} available`).join(" · ")}.{" "}
                  {props.negativeStock === "block" ? "Checkout is refused if the shelf runs out; count it in Inventory if the shelf disagrees." : "This shop allows it; on-hand will go below zero until it's counted."}
                </div>
              )}
            </div>
          </Card>

          <Card>
            <CardHeader title="Discounts & rewards" />
            <div className="space-y-3 p-4">
              <div className="flex gap-2">
                <Input placeholder="Promo code" value={promoInput} onChange={(e) => setPromoInput(e.target.value.toUpperCase())} className="uppercase" />
                {promo ? (
                  <Button variant="secondary" onClick={() => setPromo(null)}>
                    Remove {promo.code}
                  </Button>
                ) : (
                  <Button variant="secondary" disabled={!promoInput || pending} onClick={() => act(() => promoAction(props.sale.id, promoInput), (d) => setPromo(d))}>
                    Apply
                  </Button>
                )}
              </div>
              {props.loyalty && (
                <div className="rounded-lg bg-zinc-50 p-3 ring-1 ring-zinc-200">
                  <div className="flex items-center justify-between text-sm">
                    <span className="font-medium">Loyalty</span>
                    <span className="text-xs text-zinc-500 tabular">
                      {$short(props.loyalty.progressCents)} / {$short(props.loyalty.thresholdCents)} toward next reward
                    </span>
                  </div>
                  {props.loyalty.rewards.length > 0 ? (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {props.loyalty.rewards.map((r) => (
                        <button
                          key={r.id}
                          onClick={() => setRewardId(rewardId === r.id ? null : r.id)}
                          className={cx("rounded-full px-3 py-1 text-sm ring-1", rewardId === r.id ? "bg-emerald-600 text-white ring-emerald-600" : "bg-white ring-emerald-300 text-emerald-800")}
                        >
                          {rewardId === r.id ? "✓ " : ""}Use {$short(r.amountCents)} reward
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div className="mt-1 text-xs text-zinc-500">No rewards available yet.</div>
                  )}
                </div>
              )}
              {props.perms.discount && (
                <div className="grid grid-cols-[90px_1fr] gap-2 sm:grid-cols-[90px_110px_1fr]">
                  <Select value={manual.type} onChange={(e) => setManual({ ...manual, type: e.target.value as "percent" | "amount" })}>
                    <option value="percent">%</option>
                    <option value="amount">$</option>
                  </Select>
                  <Input placeholder={manual.type === "percent" ? "10" : "5.00"} inputMode="decimal" value={manual.value} onChange={(e) => setManual({ ...manual, value: e.target.value })} />
                  <Input className="col-span-2 sm:col-span-1" list="discount-reasons" placeholder="Reason (required)" value={manual.reason} onChange={(e) => setManual({ ...manual, reason: e.target.value })} />
                  <div className={cx("col-span-2 text-xs sm:col-span-3", discountProblem ? "text-red-600" : "text-zinc-500")}>
                    {discountProblem ?? (props.perms.maxDiscountPct < 100 ? `Your discount limit: ${props.perms.maxDiscountPct}%` : null)}
                  </div>
                </div>
              )}
            </div>
          </Card>
        </div>

        {/* Pay */}
        <div className="space-y-4 lg:sticky lg:top-4 lg:self-start">
          <Card>
            <CardHeader title="Tip" subtitle={`Suggested on ${$short(base.serviceGrossCents)} in services`} />
            <div className="space-y-2 p-4">
              <div className="grid grid-cols-3 gap-2">
                {tips.map((t) => (
                  <TipBtn key={t.percent} on={tipMode === `p${t.percent}`} onClick={() => pickTip(`p${t.percent}`, t.cents)} big={`${t.percent}%`} small={$short(t.cents)} />
                ))}
              </div>
              <div className="grid grid-cols-4 gap-2">
                {[500, 1000, 1500, 2000].map((c) => (
                  <TipBtn key={c} on={tipMode === `d${c}`} onClick={() => pickTip(`d${c}`, c)} big={$short(c)} />
                ))}
              </div>
              <div className="grid grid-cols-[1fr_1.4fr] gap-2">
                <TipBtn on={tipMode === "none"} onClick={() => pickTip("none", 0)} big="No tip" />
                <Input
                  placeholder="Custom $"
                  inputMode="decimal"
                  value={customTip}
                  onFocus={() => setTipMode("custom")}
                  onChange={(e) => {
                    setCustomTip(e.target.value);
                    pickTip("custom", toCents(e.target.value));
                  }}
                  className={cx("h-12 text-base", tipMode === "custom" && "ring-2 ring-ink-900")}
                />
              </div>
            </div>
          </Card>

          <Card>
            <CardHeader title="Payment" />
            <div className="space-y-3 p-4">
              <div className="flex gap-2">
                <Input placeholder="Gift card code" value={giftInput} onChange={(e) => setGiftInput(e.target.value.toUpperCase())} className="uppercase" />
                {gift ? (
                  <Button variant="secondary" onClick={() => setGift(null)}>
                    Remove
                  </Button>
                ) : (
                  <Button variant="secondary" disabled={!giftInput || pending} onClick={() => act(() => giftCardAction(giftInput), (g) => setGift({ code: g.code, balanceCents: g.balanceCents }))}>
                    Apply
                  </Button>
                )}
              </div>
              {gift && (
                <div className="text-xs text-zinc-600">
                  Gift card {gift.code}: balance {$(gift.balanceCents)}, applying {$(totals.giftCardAppliedCents)}
                </div>
              )}

              {base.primaryBaseCents > 0 && (
                <div className="grid grid-cols-2 gap-2">
                  <TenderBtn on={tender === "cash"} onClick={() => setTender("cash")} title="Cash" sub={$(preview("cash", null).primaryChargeCents)} />
                  <TenderBtn
                    on={tender === "card"}
                    onClick={() => setTender("card")}
                    title="Card"
                    sub={props.config.cardFee.enabled ? `${$(base.primaryChargeCents)} debit · ${$(creditPreview.primaryChargeCents)} credit` : $(base.primaryChargeCents)}
                  />
                </div>
              )}

              {method === "cash" && (
                <div className="space-y-2">
                  <div className="text-xs font-medium text-zinc-700">Cash tendered</div>
                  <div className="grid grid-cols-4 gap-2">
                    {cashOptions(totals.primaryChargeCents).map((c) => (
                      <TipBtn key={c} on={cashTendered === c} onClick={() => setCashTendered(c)} big={c === totals.primaryChargeCents ? "Exact" : $short(c)} />
                    ))}
                  </div>
                  {cashTendered != null && change >= 0 && (
                    <div className="rounded-lg bg-emerald-50 px-3 py-2 text-center text-emerald-900 ring-1 ring-emerald-200">
                      Change due <span className="text-xl font-semibold tabular">{$(change)}</span>
                    </div>
                  )}
                </div>
              )}

              {method === "card" && (
                <div className="space-y-3">
                  <div className="flex rounded-lg bg-zinc-100 p-1 text-sm">
                    {(["terminal", "keyed"] as const).map((m) => (
                      <button
                        key={m}
                        onClick={() => {
                          setCardMode(m);
                          setCard(null);
                        }}
                        className={cx("flex-1 rounded-md py-1.5 font-medium", cardMode === m ? "bg-white shadow-sm" : "text-zinc-600")}
                      >
                        {m === "terminal" ? "Card reader" : "Key in card"}
                      </button>
                    ))}
                  </div>
                  {card ? (
                    <div className="flex items-center justify-between rounded-lg bg-zinc-50 px-3 py-2 ring-1 ring-zinc-200">
                      <div className="text-sm">
                        <span className="font-medium capitalize">{card.brand}</span> •••• {card.last4}{" "}
                        <Badge tone={card.funding === "credit" ? "amber" : "green"}>{card.funding}</Badge>
                      </div>
                      <button className="text-xs underline" onClick={() => setCard(null)}>
                        Change
                      </button>
                    </div>
                  ) : cardMode === "terminal" || !props.payments.publishableKey ? (
                    <div>
                      <div className="mb-2 text-xs text-zinc-500">
                        {cardMode === "terminal" ? `${props.payments.terminalLabel}: tap a test card to "present" it.` : "Simulator: no publishable key, so pick a Stripe test card."}
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        {props.payments.testCards.map((tc) => (
                          <button
                            key={tc.id}
                            disabled={pending}
                            onClick={() =>
                              act(
                                () => (cardMode === "terminal" ? terminalCollectAction(tc.id) : inspectCardAction(tc.id).then((r) => (r.ok ? { ok: true as const, data: { paymentMethodId: tc.id, card: r.data } } : r))),
                                (d) => setCard({ paymentMethodId: d.paymentMethodId, ...d.card }),
                              )
                            }
                            className="rounded-lg px-2 py-2 text-left text-xs ring-1 ring-zinc-200 hover:bg-zinc-50"
                          >
                            {tc.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <StripeCardEntry
                      publishableKey={props.payments.publishableKey}
                      amountCents={totals.primaryChargeCents}
                      onPaymentMethod={(id) => act(() => inspectCardAction(id), (c) => setCard({ paymentMethodId: id, ...c }))}
                    />
                  )}
                  {props.feeNotice && <div className="text-xs text-zinc-500">{props.feeNotice}</div>}
                </div>
              )}
            </div>
          </Card>

          {props.timer && (
            <Card className="p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-xs font-medium text-zinc-700">Service time</div>
                  <div className="text-xs text-zinc-500">
                    {props.timer.times?.started && props.timer.times.finished
                      ? `${formatMinutes(props.timer.times.actualMin ?? 0)} (booked ${props.timer.times.bookedMin})`
                      : props.timer.times?.started
                        ? "Taking payment finishes the timer if you haven't."
                        : "Not started, so this cut won't be timed."}
                  </div>
                </div>
                <ServiceTimer appointmentId={props.timer.appointmentId} status={props.timer.status} times={props.timer.times} />
              </div>
            </Card>
          )}

          {props.sale.hasAppointment && (
            <Card className="p-4">
              <div className="mb-2 text-xs font-medium text-zinc-700">Rebook same barber, same time</div>
              <div className="grid grid-cols-5 gap-2">
                {[null, 2, 3, 4, 6].map((w) => (
                  <button
                    key={w ?? 0}
                    onClick={() => setRebookWeeks(w)}
                    className={cx("h-10 rounded-lg text-sm font-medium ring-1", rebookWeeks === w ? "bg-ink-900 text-white ring-ink-900" : "bg-white ring-zinc-300 hover:bg-zinc-50")}
                  >
                    {w ? `${w} wk` : "No"}
                  </button>
                ))}
              </div>
            </Card>
          )}

          <Card>
            <dl className="space-y-1 p-4 text-sm tabular">
              <Row k="Services" v={$(totals.serviceGrossCents)} />
              {totals.productGrossCents > 0 && <Row k="Products" v={$(totals.productGrossCents)} />}
              {totals.giftCardSalesCents > 0 && <Row k="Gift cards sold" v={$(totals.giftCardSalesCents)} />}
              {totals.discountBreakdown.map((d, i) => (
                <Row key={i} k={d.label} v={$(-d.cents)} className="text-emerald-700" />
              ))}
              <Row k={`Tax (services ${(props.config.taxRates.serviceRate * 100).toFixed(2)}%)`} v={$(totals.serviceTaxCents)} />
              {totals.productNetCents > 0 && <Row k={`Tax (products ${(props.config.taxRates.productRate * 100).toFixed(2)}%)`} v={$(totals.productTaxCents)} />}
              <Row k="Tip" v={$(totals.tipCents)} />
              {totals.cardFeeCents > 0 && <Row k={feeLabel({ rate: totals.cardFeeRate })} v={$(totals.cardFeeCents)} className="text-amber-700" />}
              {totals.giftCardAppliedCents > 0 && <Row k="Gift card" v={$(-totals.giftCardAppliedCents)} />}
              <div className="flex items-baseline justify-between border-t border-zinc-200 pt-2">
                <dt className="font-semibold">{totals.giftCardAppliedCents > 0 ? "Due now" : "Total"}</dt>
                <dd className="text-2xl font-semibold">{$(totals.primaryChargeCents)}</dd>
              </div>
              {totals.loyaltyEligibleCents > 0 && props.customer && <div className="pt-1 text-xs text-zinc-500">Earns {$(totals.loyaltyEligibleCents)} toward loyalty.</div>}
            </dl>
            <div className="space-y-2 border-t border-zinc-100 p-4">
              {error && <Notice tone="red">{error}</Notice>}
              {msg && <Notice tone="green">{msg}</Notice>}
              <Button size="lg" className="h-14 w-full text-lg" disabled={!ready || pending} onClick={() => (setMsg(null), charge())}>
                {pending
                  ? "Processing…"
                  : method === "none"
                    ? lines.length
                      ? "Complete (paid by gift card)"
                      : "Add items"
                    : method === "cash"
                      ? `Take ${$(totals.primaryChargeCents)} cash`
                      : !tender
                        ? "Choose cash or card"
                        : card
                          ? `Charge ${$(totals.primaryChargeCents)}`
                          : "Read card first"}
              </Button>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

function cashOptions(due: number) {
  const set = new Set<number>([due]);
  for (const step of [500, 1000, 2000]) set.add(Math.ceil(due / step) * step);
  for (const bill of [5000, 10000]) if (bill > due) set.add(bill);
  return [...set].filter((c) => c >= due).sort((a, b) => a - b).slice(0, 4);
}

function Row({ k, v, className }: { k: string; v: string; className?: string }) {
  return (
    <div className={cx("flex justify-between", className)}>
      <dt className="text-zinc-600">{k}</dt>
      <dd>{v}</dd>
    </div>
  );
}

function TipBtn({ on, onClick, big, small }: { on: boolean; onClick: () => void; big: string; small?: string }) {
  return (
    <button onClick={onClick} className={cx("flex h-12 flex-col items-center justify-center rounded-lg ring-1 transition", on ? "bg-ink-900 text-white ring-ink-900" : "bg-white ring-zinc-300 hover:bg-zinc-50")}>
      <span className="text-sm font-semibold">{big}</span>
      {small && <span className={cx("text-[11px] tabular", on ? "text-zinc-300" : "text-zinc-500")}>{small}</span>}
    </button>
  );
}

function TenderBtn({ on, onClick, title, sub }: { on: boolean; onClick: () => void; title: string; sub: string }) {
  return (
    <button onClick={onClick} className={cx("rounded-xl px-3 py-3 text-left ring-1 transition", on ? "bg-brand-600 text-white ring-brand-600" : "bg-white ring-zinc-300 hover:bg-zinc-50")}>
      <div className="font-semibold">{title}</div>
      <div className={cx("text-xs tabular", on ? "text-white/80" : "text-zinc-500")}>{sub}</div>
    </button>
  );
}

function CustomerBox({
  saleId,
  customer,
  canAdd,
  onError,
}: {
  saleId: string;
  customer: { id: string; name: string; phone: string | null; notes: string | null; rating: RatingSummary | null } | null;
  canAdd: { phone: boolean; email: boolean };
  onError: (e: string) => void;
}) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ firstName: "", lastName: "", phone: "", email: "" });
  const set = (k: keyof typeof draft) => (e: ChangeEvent<HTMLInputElement>) => setDraft((d) => ({ ...d, [k]: e.target.value }));
  const create = async (e: FormEvent) => {
    e.preventDefault();
    const r = await newClientAtCheckoutAction(saleId, draft);
    if (!r.ok) return onError(r.error);
    setAdding(false);
    setDraft({ firstName: "", lastName: "", phone: "", email: "" });
    router.refresh();
  };
  const [found, setFound] = useState<{ id: string; firstName: string; lastName: string | null; phone: string | null; rating: RatingSummary | null }[]>([]);
  useEffect(() => {
    if (q.trim().length < 2) return setFound([]);
    const t = setTimeout(async () => {
      const r = await searchCustomersAction(q);
      if (r.ok) setFound(r.data);
    }, 200);
    return () => clearTimeout(t);
  }, [q]);
  const attach = async (id: string | null) => {
    const r = await attachCustomerAction(saleId, id);
    if (!r.ok) onError(r.error);
    setQ("");
    router.refresh();
  };
  return (
    <div className="relative">
      <div className="mb-1 text-xs font-medium text-zinc-700">Client</div>
      {customer ? (
        <>
          <div className="flex h-[38px] items-center justify-between rounded-lg bg-zinc-50 px-3 text-sm ring-1 ring-zinc-200">
            <span className="flex min-w-0 items-center gap-1.5">
              <a className="truncate font-medium hover:underline" href={`/admin/customers/${customer.id}`}>
                {customer.name}
              </a>
              <StarBadge rating={customer.rating} />
            </span>
            <button className="text-xs underline" onClick={() => attach(null)}>
              Remove
            </button>
          </div>
          {customer.notes && <p className="mt-1 whitespace-pre-line rounded-md bg-amber-50 px-2 py-1 text-xs text-amber-800">{customer.notes}</p>}
        </>
      ) : adding ? (
        <form onSubmit={create} className="space-y-2 rounded-lg p-2 ring-1 ring-zinc-200">
          <div className="grid grid-cols-2 gap-2">
            <Input placeholder="First name" value={draft.firstName} onChange={set("firstName")} required autoFocus />
            <Input placeholder="Last name" value={draft.lastName} onChange={set("lastName")} />
            {canAdd.phone && <Input className="col-span-2" placeholder="Mobile" inputMode="tel" value={draft.phone} onChange={set("phone")} />}
            {canAdd.email && <Input className="col-span-2" placeholder="Email" type="email" value={draft.email} onChange={set("email")} />}
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" size="sm" variant="ghost" onClick={() => setAdding(false)}>
              Cancel
            </Button>
            <Button size="sm" disabled={!draft.firstName.trim()}>
              Add client
            </Button>
          </div>
        </form>
      ) : (
        <>
          <div className="flex gap-2">
            <Input placeholder="Search to attach (for loyalty)" value={q} onChange={(e) => setQ(e.target.value)} />
            <Button type="button" variant="secondary" onClick={() => setAdding(true)}>
              New client
            </Button>
          </div>
          {found.length > 0 && (
            <div className="absolute inset-x-0 z-10 mt-1 divide-y divide-zinc-100 rounded-lg bg-white shadow-lg ring-1 ring-zinc-200">
              {found.map((f) => (
                <button key={f.id} onClick={() => attach(f.id)} className="block w-full px-3 py-2 text-left text-sm hover:bg-zinc-50">
                  {f.firstName} {f.lastName} <StarBadge rating={f.rating} /> <span className="text-zinc-500">{f.phone}</span>
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
