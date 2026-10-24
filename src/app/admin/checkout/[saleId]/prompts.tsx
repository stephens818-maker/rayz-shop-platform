"use client";

import { useState } from "react";
import { Badge, Button, Card, CardHeader, Notice, Select, cx } from "@/components/ui";
import { INTERVAL_SOURCE_LABEL, PRODUCT_SOURCE_LABEL, STOCK_LABEL, type ProductSuggested, type RebookSuggested } from "@/domain/checkout-prompts";
import { REFILL_STATUS_LABEL, REFILL_STATUS_TONE, refillHint, type ProductHistory } from "@/domain/product-history";
import { formatDate, formatTime } from "@/lib/time";
import { acceptRebookAction, addPromptProductAction, declinePromptAction, tagUsedProductAction } from "../actions";

type Outcome = "accepted" | "declined" | null;
interface View<S> {
  id: string;
  required: boolean;
  outcome: Outcome;
  skipped: boolean;
  declineReason: string | null;
  suggested: S;
  addedProductIds: string[];
  booked: { appointmentId: string; name: string; startsAt: string; barber: string }[];
  reminderAt: string | null;
}
export interface PromptsProps {
  rebook: View<RebookSuggested> | null;
  product: View<ProductSuggested> | null;
  nextVisits: { customerId: string; name: string; startsAt: string; barber: string }[];
  used: { productId: string; name: string; brand: string }[];
  reasons: string[];
  reminders: boolean;
  waiting: ("rebook" | "product")[];
  enabled: { rebook: boolean; product: boolean };
  history: ProductHistory | null;
}
type Retail = { productId: string; name: string; brand: string; priceCents: number; stock: number; available: number };
type Act = <T>(fn: () => Promise<{ ok: true; data: T } | { ok: false; error: string }>, ok: (d: T) => void) => void;

const $short = (c: number) => `$${(c / 100).toFixed(c % 100 ? 2 : 0)}`;
const when = (t: string) => `${formatDate(new Date(t))}, ${formatTime(t)}`;

/** The rebook and product prompts at the top of the Pay column, and the products-used tags the product prompt reads. */
export function CheckoutPrompts(props: {
  saleId: string;
  prompts: PromptsProps;
  retail: Retail[];
  onTicket: (productId: string) => number;
  addProduct: (p: Retail, qty?: number) => void;
  negativeStock: "block" | "warn";
  pending: boolean;
  act: Act;
  onChanged: () => void;
}) {
  const { prompts: p } = props;
  const showProducts = p.enabled.product || !!p.product || (p.history?.total ?? 0) > 0;
  if (!p.rebook && !p.nextVisits.length && !showProducts) return null;
  return (
    <div className="space-y-4" data-testid="checkout-prompts">
      {p.rebook ? (
        <RebookCard {...props} view={p.rebook} />
      ) : (
        p.nextVisits.length > 0 && (
          <Card className="p-4">
            <div className="text-xs font-medium text-zinc-700">Next visit</div>
            <ul className="mt-1 space-y-0.5 text-sm">
              {p.nextVisits.map((v) => (
                <li key={v.customerId}>
                  {p.nextVisits.length > 1 && <span className="font-medium">{v.name.split(" ")[0]}: </span>}
                  Already booked {when(v.startsAt)} with {v.barber}
                </li>
              ))}
            </ul>
          </Card>
        )
      )}
      {showProducts && <ProductCard {...props} view={p.product} />}
    </div>
  );
}

function RequiredBadge({ on }: { on: boolean }) {
  return on ? <Badge tone="amber">Answer before payment</Badge> : null;
}

function RebookCard(props: Parameters<typeof CheckoutPrompts>[0] & { view: View<RebookSuggested> }) {
  const v = props.view;
  const s = v.suggested;
  const [declining, setDeclining] = useState(false);
  const [again, setAgain] = useState(false);
  const [reason, setReason] = useState("");
  const [remind, setRemind] = useState(props.prompts.reminders);
  const family = s.people.length > 1;
  const who = family ? s.people.map((x) => x.name.split(" ")[0]).join(", ") : s.people[0]?.name.split(" ")[0];
  const barbers = [...new Set(s.people.map((x) => x.staffName))].join(" and ");
  const open = !v.outcome || (v.outcome === "declined" && again);
  return (
    <Card>
      <CardHeader title={family ? `Rebook the family` : `Rebook ${who ?? "the client"}`} subtitle={`Every ${s.intervalDays} days (${INTERVAL_SOURCE_LABEL[s.intervalSource]}), around ${formatDate(s.targetDate)} with ${barbers}`} />
      <div className="space-y-3 p-4" data-testid="rebook-prompt">
        <RequiredBadge on={props.prompts.waiting.includes("rebook")} />
        {v.outcome === "accepted" && (
          <Notice tone="green">
            Booked{" "}
            {v.booked.length
              ? v.booked.map((b, i) => (
                  <span key={b.appointmentId}>
                    {i > 0 && "; "}
                    {family && `${b.name} `}
                    {when(b.startsAt)} with {b.barber}
                  </span>
                ))
              : "the next visit"}
            .
          </Notice>
        )}
        {v.outcome === "declined" && !again && (
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-zinc-600">
            <span>
              Not rebooked{v.skipped ? " (paid without an answer)" : ""}
              {v.declineReason ? `: ${v.declineReason}` : ""}
              {v.reminderAt ? `. Reminder to book goes ${formatDate(new Date(v.reminderAt))}.` : "."}
            </span>
            {s.options.length > 0 && (
              <Button size="sm" variant="secondary" onClick={() => setAgain(true)}>
                Book after all
              </Button>
            )}
          </div>
        )}
        {open && (
          <>
            {s.options.length ? (
              <div className={cx("grid gap-2", s.options.length === 2 ? "grid-cols-2" : "grid-cols-3")}>
                {s.options.map((o, i) => (
                  <button
                    key={o.startsAt}
                    disabled={props.pending}
                    onClick={() => props.act(() => acceptRebookAction(props.saleId, v.id, { index: i, startsAt: o.startsAt }), () => props.onChanged())}
                    className="rounded-lg px-2 py-2 text-left ring-1 ring-zinc-300 hover:bg-zinc-50 hover:ring-zinc-400 disabled:opacity-50"
                    data-testid="rebook-option"
                  >
                    <div className="text-xs text-zinc-500">{formatDate(o.date)}</div>
                    <div className="text-sm font-semibold">{formatTime(o.startsAt)}</div>
                    {family && <div className="mt-0.5 truncate text-[11px] text-zinc-500">{o.seats.map((x) => `${s.people.find((y) => y.customerId === x.customerId)?.name.split(" ")[0] ?? ""} ${formatTime(x.startsAt)}`).join(" · ")}</div>}
                  </button>
                ))}
              </div>
            ) : (
              <p className="text-sm text-zinc-600">{s.reason ?? "No openings near then."} Book from the calendar, or say why not.</p>
            )}
            {!v.outcome &&
              (declining ? (
                <div className="space-y-2 rounded-lg bg-zinc-50 p-3 ring-1 ring-zinc-200">
                  <Select value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Reason">
                    <option value="">Reason (optional)</option>
                    {props.prompts.reasons.map((r) => (
                      <option key={r}>{r}</option>
                    ))}
                  </Select>
                  {props.prompts.reminders && (
                    <label className="flex items-center gap-2 text-sm">
                      <input type="checkbox" checked={remind} onChange={(e) => setRemind(e.target.checked)} />
                      Remind them to book a few days before they&apos;re due
                    </label>
                  )}
                  <div className="flex gap-2">
                    <Button size="sm" disabled={props.pending} onClick={() => props.act(() => declinePromptAction(props.saleId, v.id, { reason: reason || null, remind: props.prompts.reminders && remind }), () => (setDeclining(false), props.onChanged()))}>
                      Save
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => setDeclining(false)}>
                      Back
                    </Button>
                  </div>
                </div>
              ) : (
                <Button size="sm" variant="secondary" onClick={() => setDeclining(true)} data-testid="rebook-decline">
                  Not now
                </Button>
              ))}
          </>
        )}
      </div>
    </Card>
  );
}

function ProductCard(props: Parameters<typeof CheckoutPrompts>[0] & { view: View<ProductSuggested> | null }) {
  const v = props.view;
  const [tag, setTag] = useState("");
  const used = new Set(props.prompts.used.map((u) => u.productId));
  const prompting = props.prompts.enabled.product || !!v;
  // On the ticket from here; a suggested product also counts as sold by the prompt.
  const add = (productId: string, qty = 1) => {
    const r = props.retail.find((x) => x.productId === productId);
    if (!r) return;
    props.addProduct(r, qty);
    if (v && v.suggested.products.some((x) => x.productId === productId)) props.act(() => addPromptProductAction(props.saleId, v.id, productId), () => props.onChanged());
  };
  return (
    <Card>
      <CardHeader title={prompting ? "Suggested products" : "Products they buy"} subtitle={prompting ? "Used in the service, made for these services, or bought before" : "Their last purchases, at every location"} />
      <div className="space-y-3 p-4" data-testid="product-prompt">
        <RequiredBadge on={props.prompts.waiting.includes("product")} />
        {props.prompts.history && props.prompts.history.total > 0 && <HistoryPanel {...props} history={props.prompts.history} add={add} />}
        {!prompting ? null : v ? (
          <ul className="space-y-2">
            {v.suggested.products.map((x) => {
              const left = x.available - props.onTicket(x.productId);
              const blocked = x.stock === "out" && props.negativeStock === "block";
              const added = props.onTicket(x.productId) > 0;
              return (
                <li key={x.productId} className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">
                      {x.brand} {x.name} <span className="tabular font-normal text-zinc-500">{$short(x.priceCents)}</span>
                    </div>
                    <div className="mt-0.5 flex flex-wrap gap-1">
                      {x.sources.map((src) => (
                        <Badge key={src} tone={src === "used" ? "violet" : src === "service" ? "blue" : "gray"}>
                          {PRODUCT_SOURCE_LABEL[src]}
                        </Badge>
                      ))}
                      <Badge tone={x.stock === "out" ? "red" : x.stock === "low" ? "amber" : "green"}>
                        {x.stock === "out" ? STOCK_LABEL.out : `${Math.max(0, left)} left`}
                      </Badge>
                      {x.refill && x.refill.status !== "stocked" && <Badge tone={REFILL_STATUS_TONE[x.refill.status]}>{REFILL_STATUS_LABEL[x.refill.status]}</Badge>}
                    </div>
                  </div>
                  {added ? (
                    <span className="text-xs font-medium text-emerald-700">On ticket</span>
                  ) : (
                    <Button size="sm" variant="secondary" disabled={props.pending || blocked} onClick={() => add(x.productId)} data-testid="prompt-add-product">
                      Add
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-sm text-zinc-500">Tag what you used in the service to suggest it here.</p>
        )}
        {v && !v.outcome && (
          <Button size="sm" variant="secondary" disabled={props.pending} onClick={() => props.act(() => declinePromptAction(props.saleId, v.id, {}), () => props.onChanged())}>
            No thanks
          </Button>
        )}
        {v?.outcome === "declined" && <p className="text-xs text-zinc-500">Client said no thanks.</p>}
        {prompting && <div className="border-t border-zinc-100 pt-3">
          <div className="mb-1 text-xs font-medium text-zinc-700">Used in the service</div>
          {props.prompts.used.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1">
              {props.prompts.used.map((u) => (
                <button
                  key={u.productId}
                  onClick={() => props.act(() => tagUsedProductAction(props.saleId, u.productId, false), () => props.onChanged())}
                  className="rounded-full bg-violet-50 px-2 py-0.5 text-xs text-violet-800 ring-1 ring-violet-200 hover:bg-violet-100"
                  title="Remove"
                >
                  {u.brand} {u.name} ×
                </button>
              ))}
            </div>
          )}
          <div className="flex gap-2">
            <Select value={tag} onChange={(e) => setTag(e.target.value)} aria-label="Product used">
              <option value="">Pick a product…</option>
              {props.retail
                .filter((r) => !used.has(r.productId))
                .map((r) => (
                  <option key={r.productId} value={r.productId}>
                    {r.brand} {r.name}
                  </option>
                ))}
            </Select>
            <Button size="sm" variant="secondary" disabled={!tag || props.pending} onClick={() => props.act(() => tagUsedProductAction(props.saleId, tag, true), () => (setTag(""), props.onChanged()))}>
              Tag
            </Button>
          </div>
        </div>}
      </div>
    </Card>
  );
}

/** The last product they bought, a few before it, and what they're likely running out of, each to buy again in one tap. */
function HistoryPanel(props: Parameters<typeof CheckoutPrompts>[0] & { history: ProductHistory; add: (productId: string, qty: number) => void }) {
  const h = props.history;
  const refill = new Map(h.refills.map((r) => [r.productId, r]));
  const recent = new Set(h.recent.map((b) => b.productId));
  const due = h.refills.filter((r) => r.status === "running_out" && !recent.has(r.productId)).slice(0, 3);
  const again = (productId: string | null, qty: number, testId: string) => {
    const r = productId ? props.retail.find((x) => x.productId === productId) : undefined;
    const blocked = !!r && props.negativeStock === "block" && r.available - props.onTicket(r.productId) < qty;
    return (
      <Button size="sm" variant="secondary" disabled={!r || blocked || props.pending} title={!productId ? "Not in the catalog" : !r ? "Not stocked here" : blocked ? "Not enough in stock" : undefined} onClick={() => props.add(productId!, qty)} data-testid={testId}>
        Buy again
      </Button>
    );
  };
  const hint = (productId: string | null) => {
    const r = productId ? refill.get(productId) : undefined;
    return r?.status && r.due ? <Badge tone={REFILL_STATUS_TONE[r.status]}>{refillHint(r, (d) => formatDate(d, "MMM d"))}</Badge> : null;
  };
  const last = h.last!;
  return (
    <div className="space-y-2 rounded-lg bg-zinc-50 p-3 ring-1 ring-zinc-200" data-testid="product-history">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-xs font-medium text-zinc-700">Last bought</div>
          <div className="truncate text-sm font-medium" data-testid="last-product">
            {last.name} <span className="font-normal text-zinc-500">× {last.qty}</span>
          </div>
          <div className="text-xs text-zinc-500">
            {formatDate(last.date, "MMM d, yyyy")} · {last.shop}
          </div>
          <div className="mt-0.5">{hint(last.productId)}</div>
        </div>
        {again(last.productId, last.qty, "buy-again-last")}
      </div>
      {h.recent.length > 1 && (
        <ul className="space-y-1 border-t border-zinc-200 pt-2">
          {h.recent.slice(1).map((b) => (
            <li key={`${b.saleId}:${b.productId ?? b.name}`} className="flex items-center justify-between gap-2 text-xs">
              <span className="min-w-0 truncate">
                <span className="text-zinc-500">{formatDate(b.date, "MMM d")} · {b.shop} · </span>
                {b.name} × {b.qty}
              </span>
              {again(b.productId, b.qty, "buy-again")}
            </li>
          ))}
        </ul>
      )}
      {due.map((r) => (
        <div key={r.productId} className="flex items-center justify-between gap-2 border-t border-zinc-200 pt-2 text-xs">
          <span className="min-w-0 truncate">
            {r.name} <Badge tone="amber">{refillHint(r, (d) => formatDate(d, "MMM d"))}</Badge>
          </span>
          {again(r.productId, r.lastQty, "buy-again")}
        </div>
      ))}
    </div>
  );
}
