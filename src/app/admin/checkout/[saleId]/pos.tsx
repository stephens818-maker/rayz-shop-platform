"use client";

import { useRouter } from "next/navigation";
import {
  type ChangeEvent,
  type FormEvent,
  Fragment,
  useEffect,
  useRef,
  useState,
  useTransition,
} from "react";
import { checkMilestonesNow } from "@/components/celebration";
import { ClientBadges } from "@/components/client-badges";
import { ClientNotesBrief } from "@/components/client-notes-brief";
import {
  type NoteBrief,
  contactPatterns,
  contactWarning,
} from "@/domain/client-notes";
import { addNoteAction } from "../../notes/actions";
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Input,
  Notice,
  Select,
  StarBadge,
  Suggestions,
  cx,
} from "@/components/ui";
import type { ShownBadge } from "@/domain/badges";
import type { RatingSummary } from "@/domain/ratings";
import { FamilyPickList } from "@/components/client-hit";
import type { ClientHit } from "@/domain/client-search";
import {
  CardFeeConfig,
  CardFunding,
  Discount,
  LineKind,
  TaxCategory,
  TaxRates,
  computeCheckout,
  feeLabel,
  manualDiscountProblem,
  tipSuggestions,
} from "@/domain/checkout";
import { CouponRule, couponDiscount, stackProblem } from "@/domain/coupons";
import {
  type TipSplitMode,
  splitBarbers,
  splitCents,
  tipWeights,
} from "@/domain/handoff";
import {
  MAX_SPLIT_TENDERS,
  PAYER_LABEL_MAX,
  evenSplit,
  groupByPerson,
  planSplitTenders,
  readiness,
  splitTenderProblem,
} from "@/domain/combined-checkout";
import { formatMinutes, type TimesView } from "@/domain/service-times";
import { searchCustomersAction } from "../../calendar/actions";
import { ServiceTimer } from "../../calendar/service-times-panel";
import {
  addFamilyToTicketAction,
  attachCustomerAction,
  endHandoffAction,
  finalizeAction,
  giftCardAction,
  handToCustomerAction,
  holdRetailAction,
  inspectCardAction,
  mergeTicketsAction,
  newClientAtCheckoutAction,
  promoAction,
  removeFamilyFromTicketAction,
  searchTicketsAction,
  setBarberAction,
  splitApartAction,
  splitOffAction,
  terminalCollectAction,
} from "../actions";
import { CheckoutPrompts, type PromptsProps } from "./prompts";
import { StripeCardEntry } from "./stripe-card";

type Line = {
  key: string;
  kind: LineKind;
  refId: string | null;
  name: string;
  unitPriceCents: number;
  qty: number;
  override?: { unitPriceCents: number; reason: string } | null;
  /** A service done by someone other than the ticket's barber; they share the tip. */
  staffId?: string | null;
  /** Family tickets: whose appointment the line is for. */
  appointmentId?: string | null;
};
type FamilyMember = {
  appointmentId: string;
  customerId: string | null;
  name: string;
  isChild: boolean;
  staffId: string | null;
  staffName: string | null;
  startsAt: string;
  status: string;
  readyAt: string | null;
};
type Resume = {
  lines: Omit<Line, "key">[];
  promoCode: string | null;
  promoCodes?: string[] | null;
  manualDiscount: {
    type: "percent" | "amount";
    value: number;
    reason: string;
  } | null;
  loyaltyRewardId: string | null;
  giftCard: { code: string; amountCents: number } | null;
  rebookInWeeks: number | null;
  tipSplit: TipSplitMode | null;
  tipByStaff?: { staffId: string; cents: number }[] | null;
  tipCents: number | null;
  cash: boolean;
};
type Card4 = {
  paymentMethodId: string;
  funding: CardFunding;
  brand: string;
  last4: string;
};
/** Everyone on the ticket, its own appointment first. */
type Person = {
  appointmentId: string;
  name: string;
  isChild: boolean;
  staffId: string | null;
  staffName: string | null;
  readyAt: string | null;
};
/** One payment of a split: cash or a card, its amount (tip included, before any surcharge) and who paid. */
type Part = {
  key: string;
  method: "cash" | "card";
  amount: string;
  payer: string;
  label: string;
  card: Card4 | null;
  cardMode: "terminal" | "keyed";
};
type Act = <T>(
  fn: () => Promise<{ ok: true; data: T } | { ok: false; error: string }>,
  ok: (d: T) => void,
) => void;

const $ = (c: number) =>
  `${c < 0 ? "-" : ""}$${(Math.abs(c) / 100).toFixed(2)}`;
const $short = (c: number) => `$${(c / 100).toFixed(c % 100 ? 2 : 0)}`;
const toCents = (s: string) => {
  const n = Number(s.replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};
let seq = 0;
const key = () => `l${++seq}`;

export function Pos(props: {
  sale: {
    id: string;
    number: number;
    staffId: string | null;
    hasAppointment: boolean;
  };
  timer: {
    appointmentId: string;
    status: string;
    times: TimesView | null;
  } | null;
  shop: { id: string; name: string; taxVerified: boolean };
  config: { taxRates: TaxRates; cardFee: CardFeeConfig; tipPresets: number[] };
  feeNotice: string | null;
  initialLines: Omit<Line, "key">[];
  customer: PosCustomer | null;
  barber: { id: string; label: string } | null;
  barbers: { id: string; label: string }[];
  services: {
    id: string;
    name: string;
    kind: "service" | "addon";
    priceCents: number;
  }[];
  retail: {
    productId: string;
    name: string;
    brand: string;
    priceCents: number;
    stock: number;
    available: number;
  }[];
  negativeStock: "block" | "warn";
  /** Rewards with an owner are someone else's on this combined ticket. */
  loyalty: {
    rewards: {
      id: string;
      amountCents: number;
      expiresAt: string | null;
      owner?: string;
    }[];
    progressCents: number;
    thresholdCents: number;
    redeemableOn: "services" | "all";
  } | null;
  payments: {
    mode: "stripe" | "simulator";
    publishableKey: string | null;
    terminalLabel: string;
    testCards: { id: string; label: string; funding: string }[];
    cards: boolean;
    noCards: string | null;
    readers: { id: string; label: string }[];
  };
  taxCategories: Record<string, TaxCategory>;
  perms: {
    discount: boolean;
    maxDiscountPct: number;
    priceOverride: boolean;
    reassign: boolean;
  };
  canAdd: { phone: boolean; email: boolean };
  reasons?: { discount: string[]; priceChange: string[] };
  handoff: { signature: boolean; unlock: "staff" | "manager" };
  /** The ticket is with the client on a customer screen right now. */
  withClient: { by: string; startedAt: string } | null;
  /** Back from the customer screen: the ticket as handed over, with the client's tip. */
  resume: Resume | null;
  /** The coupon held from the online booking, and coupons that apply automatically for this client. */
  coupons: {
    held: {
      rule: CouponRule | null;
      code: string;
      problem: string | null;
    } | null;
    auto: CouponRule[];
  };
  /** Other household members' appointments on this ticket, and today's that could join it. */
  family: { members: FamilyMember[]; candidates: FamilyMember[] };
  people: Person[];
  /** Who can pay a split payment: the ticket's client and the people on it. */
  payers: { customerId: string; name: string }[];
  /** Combine other open tickets into this one, and split people off. */
  canCombine: boolean;
  /** A family booking's deposit held as credit, for the ticket of anyone in the group. */
  groupDeposit?: {
    groupCode: string;
    code: string;
    balanceCents: number;
  } | null;
  /** The rebook and product prompts for this ticket. */
  prompts?: PromptsProps | null;
}) {
  const router = useRouter();
  const r0 = props.resume;
  const [lines, setLines] = useState<Line[]>(() =>
    (r0?.lines ?? props.initialLines).map((l) => ({ ...l, key: key() })),
  );
  const [coupons, setCoupons] = useState<CouponRule[]>(() =>
    r0
      ? []
      : [
          ...(props.coupons.held?.rule ? [props.coupons.held.rule] : []),
          ...props.coupons.auto,
        ],
  );
  const [promoInput, setPromoInput] = useState("");
  const [manual, setManual] = useState<{
    type: "percent" | "amount";
    value: string;
    reason: string;
  }>(() =>
    r0?.manualDiscount
      ? {
          type: r0.manualDiscount.type,
          value:
            r0.manualDiscount.type === "percent"
              ? String(r0.manualDiscount.value)
              : (r0.manualDiscount.value / 100).toFixed(2),
          reason: r0.manualDiscount.reason,
        }
      : { type: "percent", value: "", reason: "" },
  );
  const [rewardId, setRewardId] = useState<string | null>(
    r0?.loyaltyRewardId ?? null,
  );
  const [tipCents, setTipCents] = useState(r0?.tipCents ?? 0);
  const [tipMode, setTipMode] = useState<string>(
    r0?.tipCents ? "custom" : "none",
  );
  const [customTip, setCustomTip] = useState(
    r0?.tipCents ? (r0.tipCents / 100).toFixed(2) : "",
  );
  const [tipSplit, setTipSplit] = useState<TipSplitMode>(
    r0?.tipSplit ?? "services",
  );
  const [tipEach, setTipEach] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      (r0?.tipByStaff ?? []).map((t) => [
        t.staffId,
        (t.cents / 100).toFixed(2),
      ]),
    ),
  );
  const [splitPay, setSplitPay] = useState(false);
  const [parts, setParts] = useState<Part[]>([]);
  const [giftInput, setGiftInput] = useState(r0?.giftCard?.code ?? "");
  const [gift, setGift] = useState<{
    code: string;
    balanceCents: number;
  } | null>(null);
  const [tender, setTender] = useState<"cash" | "card" | null>(
    r0?.cash ? "cash" : null,
  );
  const [cardMode, setCardMode] = useState<"terminal" | "keyed">("terminal");
  const [readerId, setReaderId] = useState<string | null>(
    props.payments.readers[0]?.id ?? null,
  );
  const [card, setCard] = useState<Card4 | null>(null);
  const [cashTendered, setCashTendered] = useState<number | null>(null);
  const [rebookWeeks, setRebookWeeks] = useState<number | null>(
    r0?.rebookInWeeks ?? null,
  );
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [productQ, setProductQ] = useState("");
  const [giftSale, setGiftSale] = useState("");
  const [editing, setEditing] = useState<{
    key: string;
    price: string;
    reason: string;
  } | null>(null);
  const priceOf = (l: Line) => l.override?.unitPriceCents ?? l.unitPriceCents;
  const familyKey = props.people.map((m) => m.appointmentId).join(",");
  const seenKey = useRef(familyKey);
  // People combined in or split off on the server bring their lines with them (and take them away).
  useEffect(() => {
    if (seenKey.current === familyKey) return;
    seenKey.current = familyKey;
    const on = new Set(props.people.map((m) => m.appointmentId));
    setLines((cur) => {
      const have = new Set(cur.map((l) => l.appointmentId).filter(Boolean));
      const kept = cur.filter(
        (l) => !l.appointmentId || on.has(l.appointmentId),
      );
      const added = props.initialLines
        .filter(
          (l) =>
            l.appointmentId &&
            on.has(l.appointmentId) &&
            !have.has(l.appointmentId),
        )
        .map((l) => ({ ...l, key: key() }));
      const retail = props.initialLines
        .filter(
          (l) =>
            !l.appointmentId &&
            l.kind === "product" &&
            !cur.some((c) => c.kind === "product" && c.refId === l.refId),
        )
        .map((l) => ({ ...l, key: key() }));
      return kept.length === cur.length && !added.length && !retail.length
        ? cur
        : [...kept, ...added, ...retail];
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [familyKey]);
  const whoFor = (l: Line) =>
    props.people.length > 1
      ? (props.people.find((m) => m.appointmentId === l.appointmentId) ?? null)
      : null;

  const reward = props.loyalty?.rewards.find((r) => r.id === rewardId) ?? null;
  const barberOf = (l: Line) =>
    l.kind === "service" || l.kind === "addon"
      ? (l.staffId ?? props.sale.staffId)
      : null;
  const priced = lines.map((l) => ({
    ...l,
    staffId: barberOf(l),
    unitPriceCents: priceOf(l),
    taxCategory: l.refId ? props.taxCategories[l.refId] : undefined,
  }));
  const couponResults = coupons.map((c) => ({
    rule: c,
    ...couponDiscount(c, priced),
  }));
  const discounts: Discount[] = [];
  for (const c of couponResults) if (c.discount) discounts.push(c.discount);
  {
    const mv =
      manual.type === "percent"
        ? Number(manual.value) || 0
        : toCents(manual.value);
    if (mv > 0)
      discounts.push({
        source: "manual",
        label: `Discount: ${manual.reason || "manager"}`,
        type: manual.type,
        value: mv,
        appliesTo: "all",
      });
    if (reward)
      discounts.push({
        source: "loyalty",
        label: "Loyalty reward",
        type: "amount",
        value: reward.amountCents,
        appliesTo:
          props.loyalty!.redeemableOn === "services" ? "services" : "all",
      });
  }
  const couponProblem =
    stackProblem(coupons, {
      manualDiscount:
        (manual.type === "percent"
          ? Number(manual.value) || 0
          : toCents(manual.value)) > 0,
    }) ??
    couponResults.find((c) => c.problem)?.problem ??
    null;
  const manualValue =
    manual.type === "percent"
      ? Number(manual.value) || 0
      : toCents(manual.value);
  const discountProblem = props.perms.discount
    ? manualDiscountProblem(
        { type: manual.type, value: manualValue },
        priced,
        props.perms.maxDiscountPct,
      )
    : null;
  const preview = (
    method: "cash" | "card" | "none",
    funding: CardFunding | null,
  ) =>
    computeCheckout({
      lines: priced,
      discounts,
      taxRates: props.config.taxRates,
      tipCents,
      cardFee: props.config.cardFee,
      tender: {
        method,
        cardFunding: funding,
        giftCardCents: gift?.balanceCents ?? 0,
        giftCardBalanceCents: gift?.balanceCents ?? 0,
      },
    });
  const base = preview("none", null);
  const split = splitPay && base.primaryBaseCents > 0;
  const method: "cash" | "card" | "none" =
    base.primaryBaseCents === 0 || split ? "none" : (tender ?? "none");
  const single = preview(
    method,
    method === "card" ? (card?.funding ?? null) : null,
  );
  const creditPreview = preview("card", "credit");
  const tips = tipSuggestions(base.serviceGrossCents, props.config.tipPresets);
  const splitIds = splitBarbers(priced, props.sale.staffId);
  const perBarber = tipSplit === "per_barber" && splitIds.length > 0;
  const eachCents = splitIds.map((id) => ({
    staffId: id,
    cents: toCents(tipEach[id] ?? ""),
  }));
  const shares = splitIds.length
    ? splitCents(
        tipCents,
        tipWeights(
          base.lines,
          perBarber
            ? "per_barber"
            : tipSplit === "per_barber"
              ? "services"
              : tipSplit,
          perBarber ? eachCents : undefined,
        ).map((w) => ({ id: w.staffId, weight: w.weight })),
      )
    : null;

  // Split payment: each part's surcharge on its own credit card, the tip on as few parts as it fits.
  const partsIn = parts.map((p) => ({
    key: p.key,
    method: p.method,
    amountCents: toCents(p.amount),
    funding: p.card?.funding ?? null,
  }));
  const splitProblem = split
    ? splitTenderProblem(base.primaryBaseCents, partsIn)
    : null;
  const plan = split
    ? planSplitTenders({
        tipCents: Math.min(tipCents, base.primaryBaseCents),
        cardFee: props.config.cardFee,
        tenders: partsIn,
      })
    : null;
  const totals =
    split && plan
      ? {
          ...base,
          cardFeeCents: plan.cardFeeCents,
          cardFeeRate: creditPreview.cardFeeRate,
          primaryChargeCents: plan.chargeCents,
          totalCents: base.preFeeTotalCents + plan.cardFeeCents,
        }
      : single;
  const newPart = (cents: number, payer: string): Part => ({
    key: key(),
    method: "cash",
    amount: (cents / 100).toFixed(2),
    payer,
    label: "",
    card: null,
    cardMode: "terminal",
  });
  const startSplit = () => {
    const amounts = evenSplit(base.primaryBaseCents, 2);
    setParts(
      amounts.map((c, i) =>
        newPart(
          c,
          props.payers[i]?.customerId ?? props.payers[0]?.customerId ?? "",
        ),
      ),
    );
    setSplitPay(true);
  };
  const splitEvenly = () =>
    setParts((ps) =>
      ps.map((p, i) => ({
        ...p,
        amount: (evenSplit(base.primaryBaseCents, ps.length)[i] / 100).toFixed(
          2,
        ),
      })),
    );
  const setPart = (k: string, patch: Partial<Part>) =>
    setParts((ps) => ps.map((p) => (p.key === k ? { ...p, ...patch } : p)));
  const restTo = (k: string) =>
    setPart(k, {
      amount: (
        Math.max(
          0,
          base.primaryBaseCents -
            partsIn
              .filter((p) => p.key !== k)
              .reduce((a, p) => a + p.amountCents, 0),
        ) / 100
      ).toFixed(2),
    });
  const barberName = (id: string) =>
    props.barbers.find((b) => b.id === id)?.label ??
    (props.barber?.id === id ? props.barber.label : "Barber");

  // Picking a returned ticket back up: re-check the promo and gift card it was handed over with.
  useEffect(() => {
    if (!r0) return;
    for (const code of [r0.promoCode, ...(r0.promoCodes ?? [])].filter(
      (c): c is string => !!c,
    ))
      promoAction(props.sale.id, code).then((r) =>
        r.ok
          ? setCoupons((cs) =>
              cs.some((c) => c.promoId === r.data.promoId)
                ? cs
                : [...cs, r.data],
            )
          : setError(r.error),
      );
    if (r0.giftCard)
      giftCardAction(r0.giftCard.code).then((r) =>
        r.ok
          ? setGift({ code: r.data.code, balanceCents: r.data.balanceCents })
          : setError(r.error),
      );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => setCashTendered(null), [totals.primaryChargeCents]);

  const setLineQty = (k: string, qty: number) =>
    setLines((ls) =>
      qty <= 0
        ? ls.filter((l) => l.key !== k)
        : ls.map((l) => (l.key === k ? { ...l, qty } : l)),
    );
  const addProduct = (p: (typeof props.retail)[number], qty = 1) =>
    setLines((ls) => {
      const ex = ls.find(
        (l) => l.kind === "product" && l.refId === p.productId,
      );
      if (ex) return ls.map((l) => (l === ex ? { ...l, qty: l.qty + qty } : l));
      return [
        ...ls,
        {
          key: key(),
          kind: "product",
          refId: p.productId,
          name: `${p.brand} ${p.name}`,
          unitPriceCents: p.priceCents,
          qty,
        },
      ];
    });

  const addFree = (f: NonNullable<CouponRule["freeItem"]>) => {
    if (f.kind === "product") {
      const p = props.retail.find((x) => x.productId === f.id);
      if (p) addProduct(p);
      else setError(`${f.name} isn't stocked here`);
      return;
    }
    const sv = props.services.find((x) => x.id === f.id);
    if (sv)
      setLines((ls) => [
        ...ls,
        {
          key: key(),
          kind: sv.kind,
          refId: sv.id,
          name: sv.name,
          unitPriceCents: sv.priceCents,
          qty: 1,
        },
      ]);
    else setError(`${f.name} isn't on the ${props.shop.name} menu`);
  };

  const act = <T,>(
    fn: () => Promise<{ ok: true; data: T } | { ok: false; error: string }>,
    ok: (d: T) => void,
  ) =>
    start(async () => {
      setError(null);
      const r = await fn();
      if (r.ok) ok(r.data);
      else setError(r.error);
    });

  const pickTip = (mode: string, cents: number) => {
    setTipMode(mode);
    setTipCents(cents);
    if (tipSplit === "per_barber") setTipSplit("services");
  };
  const eachBarber = () => {
    setTipEach(
      Object.fromEntries(
        splitIds.map((id) => [id, ((shares?.get(id) ?? 0) / 100).toFixed(2)]),
      ),
    );
    setTipSplit("per_barber");
  };
  const setEach = (id: string, v: string) => {
    const next = { ...tipEach, [id]: v };
    setTipEach(next);
    const sum = splitIds.reduce((a, x) => a + toCents(next[x] ?? ""), 0);
    setTipMode("custom");
    setCustomTip((sum / 100).toFixed(2));
    setTipCents(sum);
  };

  const charge = () =>
    act(
      () =>
        finalizeAction({
          saleId: props.sale.id,
          lines: lines.map(
            ({
              kind,
              refId,
              name,
              unitPriceCents,
              qty,
              override,
              staffId,
              appointmentId,
            }) => ({
              kind,
              refId,
              name,
              unitPriceCents,
              qty,
              priceOverride: override ?? null,
              staffId: staffId ?? null,
              appointmentId: appointmentId ?? null,
            }),
          ),
          promoCode: coupons[0]?.code ?? null,
          promoCodes: coupons.slice(1).map((c) => c.code),
          manualDiscount: manual.value
            ? {
                type: manual.type,
                value:
                  manual.type === "percent"
                    ? Number(manual.value) || 0
                    : toCents(manual.value),
                reason: manual.reason,
              }
            : null,
          loyaltyRewardId: rewardId,
          tipCents,
          giftCard: gift
            ? { code: gift.code, amountCents: gift.balanceCents }
            : null,
          tender: split
            ? { method: "cash", cashTenderedCents: null }
            : method === "cash"
              ? { method: "cash", cashTenderedCents: cashTendered }
              : method === "card"
                ? {
                    method: "card",
                    paymentMethodId: card!.paymentMethodId,
                    entryMode: cardMode,
                    readerId: cardMode === "terminal" ? readerId : null,
                  }
                : { method: "none" },
          tenders: split
            ? parts.map((p) => ({
                ...(p.method === "cash"
                  ? { method: "cash" as const, cashTenderedCents: null }
                  : {
                      method: "card" as const,
                      paymentMethodId: p.card!.paymentMethodId,
                      entryMode: p.cardMode,
                      readerId: p.cardMode === "terminal" ? readerId : null,
                    }),
                amountCents: toCents(p.amount),
                payerCustomerId:
                  p.payer && p.payer !== "other" ? p.payer : null,
                payerLabel: p.payer === "other" ? p.label : null,
              }))
            : null,
          expectedTotalCents: totals.totalCents,
          rebookInWeeks: rebookWeeks,
          tipSplit: splitIds.length
            ? perBarber
              ? "per_barber"
              : tipSplit === "per_barber"
                ? "services"
                : tipSplit
            : null,
          tipByStaff: perBarber ? eachCents : null,
          ticketPeople: props.people.map((p) => p.appointmentId),
        }),
      (d) => {
        const q = new URLSearchParams({ done: "1" });
        if (d.rebook && "code" in d.rebook && d.rebook.code)
          q.set("rebook", d.rebook.code);
        if (d.rebook && "error" in d.rebook && d.rebook.error)
          q.set("rebookError", d.rebook.error);
        if (d.rewardsIssued) q.set("rewards", String(d.rewardsIssued));
        if (d.stockWarnings.length) q.set("stock", d.stockWarnings.join("\n"));
        checkMilestonesNow();
        router.push(`/admin/sales/${d.saleId}?${q}`);
      },
    );

  const handToCustomer = () =>
    act(
      () =>
        handToCustomerAction(props.sale.id, {
          lines: lines.map(
            ({
              kind,
              refId,
              name,
              unitPriceCents,
              qty,
              override,
              staffId,
              appointmentId,
            }) => ({
              kind,
              refId,
              name,
              unitPriceCents,
              qty,
              priceOverride: override ?? null,
              staffId: staffId ?? null,
              appointmentId: appointmentId ?? null,
            }),
          ),
          promoCode: coupons[0]?.code ?? null,
          promoCodes: coupons.slice(1).map((c) => c.code),
          manualDiscount: manual.value
            ? { type: manual.type, value: manualValue, reason: manual.reason }
            : null,
          loyaltyRewardId: rewardId,
          giftCard: gift
            ? { code: gift.code, amountCents: gift.balanceCents }
            : null,
          rebookInWeeks: rebookWeeks,
          tipSplit: splitIds.length
            ? tipSplit === "per_barber"
              ? "services"
              : tipSplit
            : null,
        }),
      (d) => window.location.replace(`/handoff/${d.id}`),
    );

  const waiting = props.prompts?.waiting ?? [];
  const waitingMsg = waiting.length
    ? `Answer ${waiting.map((k) => (k === "rebook" ? "the rebook prompt" : "the product suggestions")).join(" and ")} before taking payment.`
    : null;
  const ready =
    !waiting.length &&
    !props.withClient &&
    lines.length > 0 &&
    (split
      ? !splitProblem && parts.every((p) => p.method === "cash" || !!p.card)
      : (method === "none" && base.primaryBaseCents === 0) ||
        method === "cash" ||
        (method === "card" && !!card));
  const change =
    cashTendered != null ? cashTendered - totals.primaryChargeCents : 0;
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
      const list = held
        ? held
            .split(",")
            .map((x) => ({
              productId: x.split(":")[0],
              qty: Number(x.split(":")[1]),
            }))
        : [];
      holdRetailAction(props.sale.id, list).then(
        (r) => r.ok && setSavedHold(held),
      );
    }, 600);
    return () => clearTimeout(t);
  }, [held, savedHold, props.sale.id]);
  const onTicket = (productId: string) =>
    lines
      .filter((l) => l.kind === "product" && l.refId === productId)
      .reduce((a, l) => a + l.qty, 0);
  const short = props.retail.filter((p) => onTicket(p.productId) > p.available);
  const grouped =
    props.people.length > 1
      ? groupByPerson(
          priced.map((l, i) => ({ ...l, line: lines[i] })),
          props.people.map((p) => ({
            appointmentId: p.appointmentId,
            name: p.name,
          })),
          {
            leadAppointmentId: props.people[0].appointmentId,
            otherLabel: "Retail and other",
          },
        )
      : null;
  const ticketBarberLabel = props.barber?.label ?? "Ticket barber";
  const filteredRetail = props.retail
    .filter(
      (p) =>
        !productQ ||
        `${p.brand} ${p.name}`.toLowerCase().includes(productQ.toLowerCase()),
    )
    .slice(0, 12);

  return (
    <div className="mx-auto max-w-6xl">
      <Suggestions
        id="discount-reasons"
        items={props.reasons?.discount ?? []}
      />
      <Suggestions
        id="price-reasons"
        items={props.reasons?.priceChange ?? []}
      />
      <div className="mb-4 flex flex-wrap items-end justify-between gap-2">
        <div>
          <div className="text-xs font-medium uppercase tracking-wide text-zinc-500">
            {props.shop.name} · Ticket #{props.sale.number}
          </div>
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
            Checkout
          </h1>
        </div>
        <Badge tone={props.payments.mode === "stripe" ? "violet" : "gray"}>
          {props.payments.mode === "stripe"
            ? "Stripe test mode"
            : "Payment simulator (no Stripe keys)"}
        </Badge>
      </div>
      {!props.shop.taxVerified && (
        <div className="mb-3">
          <Notice>
            Tax rates for {props.shop.name} are placeholders until verified in
            Shop settings.
          </Notice>
        </div>
      )}
      {props.withClient && (
        <div
          className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-blue-50 px-3 py-2 text-sm text-blue-900 ring-1 ring-blue-200"
          role="status"
        >
          <span>
            This ticket is with the client on the customer screen (handed over
            by {props.withClient.by} at{" "}
            {new Date(props.withClient.startedAt).toLocaleTimeString([], {
              hour: "numeric",
              minute: "2-digit",
            })}
            ). A staff PIN on that screen takes it back.
          </span>
          <Button
            size="sm"
            variant="secondary"
            disabled={pending}
            onClick={() =>
              act(
                () => endHandoffAction(props.sale.id),
                () => router.refresh(),
              )
            }
          >
            End hand-off here
          </Button>
        </div>
      )}
      {r0 && !props.withClient && (
        <div className="mb-3">
          <Notice tone="blue">
            Back from the customer screen.{" "}
            {r0.cash
              ? `The client wants to pay cash${r0.tipCents ? ` with a ${$(r0.tipCents)} tip` : ""}.`
              : r0.tipCents != null
                ? `Their ${$(r0.tipCents)} tip is filled in.`
                : "They hadn't chosen a tip yet."}
          </Notice>
        </div>
      )}
      <div className="grid gap-4 lg:grid-cols-[1fr_400px]">
        {/* Ticket */}
        <div className="space-y-4">
          <Card>
            <div className="grid gap-3 p-4 sm:grid-cols-2">
              <CustomerBox
                saleId={props.sale.id}
                customer={props.customer}
                canAdd={props.canAdd}
                onError={setError}
              />
              <div>
                <div className="mb-1 text-xs font-medium text-zinc-700">
                  Barber (gets service credit + tip)
                </div>
                <Select
                  value={props.sale.staffId ?? ""}
                  disabled={!props.perms.reassign}
                  onChange={(e) =>
                    act(
                      () =>
                        setBarberAction(props.sale.id, e.target.value || null),
                      () => router.refresh(),
                    )
                  }
                >
                  <option value="">Unassigned</option>
                  {props.barbers.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.label}
                    </option>
                  ))}
                  {props.barber &&
                    !props.barbers.some((b) => b.id === props.barber!.id) && (
                      <option value={props.barber.id}>
                        {props.barber.label}
                      </option>
                    )}
                </Select>
              </div>
            </div>
          </Card>

          {(props.people.length > 1 ||
            props.family.candidates.length > 0 ||
            (props.canCombine && !props.withClient)) && (
            <PeopleCard
              saleId={props.sale.id}
              people={props.people}
              family={props.family}
              canCombine={props.canCombine && !props.withClient}
              pending={pending}
              act={act}
              onChanged={() => router.refresh()}
            />
          )}

          <Card>
            <CardHeader title="Items" />
            <ul className="divide-y divide-zinc-100">
              {lines.length === 0 && (
                <li className="px-4 py-6 text-center text-sm text-zinc-500">
                  Add a service, product or gift card below.
                </li>
              )}
              {(
                grouped ?? [
                  {
                    appointmentId: null,
                    name: "",
                    barbers: [],
                    lines: lines.map((l) => ({ line: l })),
                  },
                ]
              ).map((g) => (
                <Fragment key={g.appointmentId ?? "other"}>
                  {grouped && (
                    <li
                      className="flex items-baseline justify-between gap-2 bg-zinc-50 px-4 py-1.5 text-xs"
                      data-testid="pos-person"
                    >
                      <span>
                        <span className="font-semibold text-zinc-900">
                          {g.name}
                        </span>
                        {g.barbers.length > 0 && (
                          <span className="text-zinc-500">
                            {" "}
                            · with{" "}
                            {[
                              ...new Set(
                                g.barbers.map((b) =>
                                  b.staffId
                                    ? barberName(b.staffId)
                                    : ticketBarberLabel,
                                ),
                              ),
                            ].join(" & ")}
                          </span>
                        )}
                        {g.appointmentId &&
                          props.people.find(
                            (p) => p.appointmentId === g.appointmentId,
                          )?.readyAt && (
                            <span className="ml-1.5 font-medium text-emerald-700">
                              ready
                            </span>
                          )}
                      </span>
                      <span className="tabular font-medium">
                        {$(
                          g.lines.reduce(
                            (a, x) => a + priceOf(x.line) * x.line.qty,
                            0,
                          ),
                        )}
                      </span>
                    </li>
                  )}
                  {g.lines.map(({ line: l }) => (
                    <li
                      key={l.key}
                      className="flex items-center gap-3 px-4 py-2.5"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium">
                          {l.name}
                        </div>
                        <div className="text-xs capitalize text-zinc-500">
                          {l.kind.replace("_", " ")}
                          {whoFor(l) && (
                            <span className="normal-case text-violet-700">
                              {" "}
                              · for {whoFor(l)!.name}
                            </span>
                          )}
                          {l.override && (
                            <span className="normal-case text-amber-700">
                              {" "}
                              · price changed: {l.override.reason}
                            </span>
                          )}
                        </div>
                        {(l.kind === "service" || l.kind === "addon") &&
                          props.perms.reassign &&
                          props.barbers.length > 1 && (
                            <select
                              aria-label={`Barber for ${l.name}`}
                              className="mt-1 max-w-full rounded-md border border-zinc-200 bg-white px-1.5 py-0.5 text-xs text-zinc-700"
                              value={l.staffId ?? ""}
                              onChange={(e) =>
                                setLines((ls) =>
                                  ls.map((x) =>
                                    x.key === l.key
                                      ? {
                                          ...x,
                                          staffId: e.target.value || null,
                                        }
                                      : x,
                                  ),
                                )
                              }
                            >
                              <option value="">
                                {props.barber
                                  ? `${props.barber.label} (ticket barber)`
                                  : "Ticket barber"}
                              </option>
                              {props.barbers
                                .filter((b) => b.id !== props.sale.staffId)
                                .map((b) => (
                                  <option key={b.id} value={b.id}>
                                    {b.label}
                                  </option>
                                ))}
                            </select>
                          )}
                        {grouped &&
                          (l.kind === "service" || l.kind === "addon") && (
                            <select
                              aria-label={`Who ${l.name} is for`}
                              className="ml-1 mt-1 max-w-full rounded-md border border-zinc-200 bg-white px-1.5 py-0.5 text-xs text-zinc-700"
                              value={
                                l.appointmentId ?? props.people[0].appointmentId
                              }
                              onChange={(e) => {
                                const who = props.people.find(
                                  (p) => p.appointmentId === e.target.value,
                                );
                                setLines((ls) =>
                                  ls.map((x) =>
                                    x.key === l.key
                                      ? {
                                          ...x,
                                          appointmentId: e.target.value,
                                          staffId:
                                            who?.staffId &&
                                            who.staffId !== props.sale.staffId
                                              ? who.staffId
                                              : null,
                                        }
                                      : x,
                                  ),
                                );
                              }}
                            >
                              {props.people.map((p) => (
                                <option
                                  key={p.appointmentId}
                                  value={p.appointmentId}
                                >
                                  For {p.name}
                                </option>
                              ))}
                            </select>
                          )}
                      </div>
                      {l.kind === "product" ? (
                        <div className="flex items-center rounded-lg ring-1 ring-zinc-300">
                          <button
                            className="h-8 w-8 text-lg"
                            onClick={() => setLineQty(l.key, l.qty - 1)}
                            aria-label="Less"
                          >
                            −
                          </button>
                          <span className="w-6 text-center text-sm tabular">
                            {l.qty}
                          </span>
                          <button
                            className="h-8 w-8 text-lg"
                            onClick={() => setLineQty(l.key, l.qty + 1)}
                            aria-label="More"
                          >
                            +
                          </button>
                        </div>
                      ) : (
                        <button
                          className="text-xs text-zinc-400 hover:text-red-600"
                          onClick={() => setLineQty(l.key, 0)}
                        >
                          Remove
                        </button>
                      )}
                      {props.perms.priceOverride && l.kind !== "gift_card" ? (
                        <button
                          className={cx(
                            "w-20 text-right text-sm tabular underline decoration-dotted underline-offset-2",
                            l.override && "text-amber-700",
                          )}
                          title="Change price"
                          onClick={() =>
                            setEditing({
                              key: l.key,
                              price: (priceOf(l) / 100).toFixed(2),
                              reason: l.override?.reason ?? "",
                            })
                          }
                        >
                          {$(priceOf(l) * l.qty)}
                        </button>
                      ) : (
                        <div className="w-20 text-right text-sm tabular">
                          {$(priceOf(l) * l.qty)}
                        </div>
                      )}
                    </li>
                  ))}
                </Fragment>
              ))}
              {editing && (
                <li className="space-y-2 bg-amber-50 px-4 py-3">
                  <div className="text-xs font-medium text-amber-900">
                    Change price for{" "}
                    {lines.find((l) => l.key === editing.key)?.name} (menu{" "}
                    {$(
                      lines.find((l) => l.key === editing.key)
                        ?.unitPriceCents ?? 0,
                    )}
                    ). Logged with your name.
                  </div>
                  <div className="grid grid-cols-[100px_1fr_auto_auto] gap-2">
                    <Input
                      inputMode="decimal"
                      value={editing.price}
                      onChange={(e) =>
                        setEditing({ ...editing, price: e.target.value })
                      }
                      aria-label="New unit price"
                    />
                    <Input
                      list="price-reasons"
                      placeholder="Reason (required)"
                      value={editing.reason}
                      onChange={(e) =>
                        setEditing({ ...editing, reason: e.target.value })
                      }
                    />
                    <Button
                      size="sm"
                      disabled={!editing.reason.trim()}
                      onClick={() => {
                        const cents = toCents(editing.price);
                        setLines((ls) =>
                          ls.map((l) =>
                            l.key === editing.key
                              ? {
                                  ...l,
                                  override:
                                    cents === l.unitPriceCents
                                      ? null
                                      : {
                                          unitPriceCents: cents,
                                          reason: editing.reason.trim(),
                                        },
                                }
                              : l,
                          ),
                        );
                        setEditing(null);
                      }}
                    >
                      Save
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        setLines((ls) =>
                          ls.map((l) =>
                            l.key === editing.key
                              ? { ...l, override: null }
                              : l,
                          ),
                        );
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
                <div className="mb-1 text-xs font-medium text-zinc-700">
                  Add service
                </div>
                <Select
                  value=""
                  onChange={(e) => {
                    const s = props.services.find(
                      (x) => x.id === e.target.value,
                    );
                    if (s)
                      setLines((ls) => [
                        ...ls,
                        {
                          key: key(),
                          kind: s.kind,
                          refId: s.id,
                          name: s.name,
                          unitPriceCents: s.priceCents,
                          qty: 1,
                        },
                      ]);
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
                <div className="mb-1 text-xs font-medium text-zinc-700">
                  Sell a gift card
                </div>
                <div className="flex gap-2">
                  <Input
                    placeholder="$ amount"
                    inputMode="decimal"
                    value={giftSale}
                    onChange={(e) => setGiftSale(e.target.value)}
                  />
                  <Button
                    variant="secondary"
                    onClick={() => {
                      const c = toCents(giftSale);
                      if (c < 500 || c > 50_000)
                        return setError("Gift cards are sold from $5 to $500");
                      setLines((ls) => [
                        ...ls,
                        {
                          key: key(),
                          kind: "gift_card",
                          refId: null,
                          name: `Gift card ${$short(c)}`,
                          unitPriceCents: c,
                          qty: 1,
                        },
                      ]);
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
                <Input
                  className="max-w-48 py-1"
                  placeholder="Search products"
                  value={productQ}
                  onChange={(e) => setProductQ(e.target.value)}
                />
              </div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {filteredRetail.map((p) => (
                  <button
                    key={p.productId}
                    onClick={() => addProduct(p)}
                    className="rounded-lg px-2.5 py-2 text-left ring-1 ring-zinc-200 hover:bg-zinc-50 hover:ring-zinc-300"
                  >
                    <div className="truncate text-xs text-zinc-500">
                      {p.brand}
                    </div>
                    <div className="truncate text-sm font-medium">{p.name}</div>
                    <div className="mt-0.5 flex justify-between text-xs">
                      <span className="tabular">{$short(p.priceCents)}</span>
                      <span
                        className={
                          p.available - onTicket(p.productId) <= 0
                            ? "text-red-600"
                            : "text-zinc-400"
                        }
                      >
                        {Math.max(0, p.available - onTicket(p.productId))} left
                      </span>
                    </div>
                  </button>
                ))}
              </div>
              {short.length > 0 && (
                <div
                  className={cx(
                    "mt-2 rounded-md px-3 py-2 text-xs",
                    props.negativeStock === "block"
                      ? "bg-red-50 text-red-700"
                      : "bg-amber-50 text-amber-800",
                  )}
                >
                  {short
                    .map(
                      (p) =>
                        `${p.brand} ${p.name}: ${Math.max(0, p.available)} available`,
                    )
                    .join(" · ")}
                  .{" "}
                  {props.negativeStock === "block"
                    ? "Checkout is refused if the shelf runs out; count it in Inventory if the shelf disagrees."
                    : "This shop allows it; on-hand will go below zero until it's counted."}
                </div>
              )}
            </div>
          </Card>

          <Card>
            <CardHeader title="Discounts & rewards" />
            <div className="space-y-3 p-4">
              <div className="flex gap-2">
                <Input
                  placeholder="Coupon or promo code"
                  value={promoInput}
                  onChange={(e) => setPromoInput(e.target.value.toUpperCase())}
                  className="uppercase"
                />
                <Button
                  variant="secondary"
                  disabled={!promoInput || pending}
                  onClick={() =>
                    act(
                      () => promoAction(props.sale.id, promoInput),
                      (d) => {
                        setCoupons((cs) =>
                          cs.some((c) => c.promoId === d.promoId)
                            ? cs
                            : [...cs, d],
                        );
                        setPromoInput("");
                      },
                    )
                  }
                >
                  Apply
                </Button>
              </div>
              {props.coupons.held?.problem && (
                <Notice tone="amber">
                  Coupon {props.coupons.held.code} from the online booking
                  can&apos;t be used: {props.coupons.held.problem}.
                </Notice>
              )}
              {couponResults.map((c) => (
                <div
                  key={c.rule.promoId}
                  className="flex items-center justify-between gap-2 rounded-lg bg-zinc-50 px-3 py-2 text-sm ring-1 ring-zinc-200"
                >
                  <span>
                    <span className="font-medium">{c.rule.label}</span>
                    {c.rule.via !== "code" && (
                      <Badge tone="blue">
                        {c.rule.via === "booking"
                          ? "From online booking"
                          : "Applied automatically"}
                      </Badge>
                    )}
                    {c.problem && (
                      <span className="block text-xs text-amber-700">
                        {c.problem}
                      </span>
                    )}
                  </span>
                  {c.problem &&
                    c.rule.freeItem &&
                    !lines.some((l) => l.refId === c.rule.freeItem!.id) && (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => addFree(c.rule.freeItem!)}
                      >
                        Add {c.rule.freeItem.name}
                      </Button>
                    )}
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      setCoupons((cs) =>
                        cs.filter((x) => x.promoId !== c.rule.promoId),
                      )
                    }
                  >
                    Remove
                  </Button>
                </div>
              ))}
              {couponProblem &&
                couponResults.length > 0 &&
                !couponResults.some((c) => c.problem === couponProblem) && (
                  <p className="text-xs text-amber-700">{couponProblem}</p>
                )}
              {props.loyalty && (
                <div className="rounded-lg bg-zinc-50 p-3 ring-1 ring-zinc-200">
                  <div className="flex items-center justify-between text-sm">
                    <span className="font-medium">Loyalty</span>
                    <span className="text-xs text-zinc-500 tabular">
                      {$short(props.loyalty.progressCents)} /{" "}
                      {$short(props.loyalty.thresholdCents)} toward next reward
                    </span>
                  </div>
                  {props.loyalty.rewards.length > 0 ? (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {props.loyalty.rewards.map((r) => (
                        <button
                          key={r.id}
                          onClick={() =>
                            setRewardId(rewardId === r.id ? null : r.id)
                          }
                          className={cx(
                            "rounded-full px-3 py-1 text-sm ring-1",
                            rewardId === r.id
                              ? "bg-emerald-600 text-white ring-emerald-600"
                              : "bg-white ring-emerald-300 text-emerald-800",
                          )}
                        >
                          {rewardId === r.id ? "✓ " : ""}Use{" "}
                          {$short(r.amountCents)} reward
                          {r.owner ? ` (${r.owner}'s)` : ""}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div className="mt-1 text-xs text-zinc-500">
                      No rewards available yet.
                    </div>
                  )}
                </div>
              )}
              {props.perms.discount && (
                <div className="grid grid-cols-[90px_1fr] gap-2 sm:grid-cols-[90px_110px_1fr]">
                  <Select
                    value={manual.type}
                    onChange={(e) =>
                      setManual({
                        ...manual,
                        type: e.target.value as "percent" | "amount",
                      })
                    }
                  >
                    <option value="percent">%</option>
                    <option value="amount">$</option>
                  </Select>
                  <Input
                    placeholder={manual.type === "percent" ? "10" : "5.00"}
                    inputMode="decimal"
                    value={manual.value}
                    onChange={(e) =>
                      setManual({ ...manual, value: e.target.value })
                    }
                  />
                  <Input
                    className="col-span-2 sm:col-span-1"
                    list="discount-reasons"
                    placeholder="Reason (required)"
                    value={manual.reason}
                    onChange={(e) =>
                      setManual({ ...manual, reason: e.target.value })
                    }
                  />
                  <div
                    className={cx(
                      "col-span-2 text-xs sm:col-span-3",
                      discountProblem ? "text-red-600" : "text-zinc-500",
                    )}
                  >
                    {discountProblem ??
                      (props.perms.maxDiscountPct < 100
                        ? `Your discount limit: ${props.perms.maxDiscountPct}%`
                        : null)}
                  </div>
                </div>
              )}
            </div>
          </Card>
        </div>

        {/* Pay */}
        <div className="space-y-4 lg:sticky lg:top-4 lg:self-start">
          {props.prompts && !props.withClient && (
            <CheckoutPrompts
              saleId={props.sale.id}
              prompts={props.prompts}
              retail={props.retail}
              onTicket={onTicket}
              addProduct={addProduct}
              negativeStock={props.negativeStock}
              pending={pending}
              act={act}
              onChanged={() => router.refresh()}
            />
          )}
          <Card>
            <CardHeader
              title="Tip"
              subtitle={`Suggested on ${$short(base.serviceGrossCents)} in services`}
            />
            <div className="space-y-2 p-4">
              <div className="grid grid-cols-3 gap-2">
                {tips.map((t) => (
                  <TipBtn
                    key={t.percent}
                    on={tipMode === `p${t.percent}`}
                    onClick={() => pickTip(`p${t.percent}`, t.cents)}
                    big={`${t.percent}%`}
                    small={$short(t.cents)}
                  />
                ))}
              </div>
              <div className="grid grid-cols-4 gap-2">
                {[500, 1000, 1500, 2000].map((c) => (
                  <TipBtn
                    key={c}
                    on={tipMode === `d${c}`}
                    onClick={() => pickTip(`d${c}`, c)}
                    big={$short(c)}
                  />
                ))}
              </div>
              <div className="grid grid-cols-[1fr_1.4fr] gap-2">
                <TipBtn
                  on={tipMode === "none"}
                  onClick={() => pickTip("none", 0)}
                  big="No tip"
                />
                <Input
                  placeholder="Custom $"
                  inputMode="decimal"
                  value={customTip}
                  readOnly={perBarber}
                  onFocus={() => setTipMode("custom")}
                  onChange={(e) => {
                    setCustomTip(e.target.value);
                    pickTip("custom", toCents(e.target.value));
                  }}
                  className={cx(
                    "h-12 text-base",
                    tipMode === "custom" && "ring-2 ring-ink-900",
                  )}
                />
              </div>
              {shares && (
                <div
                  className="rounded-lg bg-zinc-50 p-3 text-sm ring-1 ring-zinc-200"
                  data-testid="tip-split"
                >
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <span className="font-medium">Split the tip</span>
                    <div className="flex rounded-md bg-zinc-200/70 p-0.5 text-xs">
                      {(["services", "even", "per_barber"] as const).map(
                        (m) => (
                          <button
                            key={m}
                            onClick={() =>
                              m === "per_barber" ? eachBarber() : setTipSplit(m)
                            }
                            className={cx(
                              "rounded px-2 py-1 font-medium",
                              tipSplit === m
                                ? "bg-white shadow-sm"
                                : "text-zinc-600",
                            )}
                            data-testid={`tip-split-${m}`}
                          >
                            {m === "services"
                              ? "By services"
                              : m === "even"
                                ? "Evenly"
                                : "Each barber"}
                          </button>
                        ),
                      )}
                    </div>
                  </div>
                  {perBarber ? (
                    <ul className="space-y-1.5 tabular">
                      {splitIds.map((id) => (
                        <li
                          key={id}
                          className="flex items-center justify-between gap-2"
                        >
                          <span>{barberName(id)}</span>
                          <Input
                            className="w-24 py-1 text-right"
                            inputMode="decimal"
                            placeholder="0.00"
                            aria-label={`Tip for ${barberName(id)}`}
                            value={tipEach[id] ?? ""}
                            onChange={(e) => setEach(id, e.target.value)}
                          />
                        </li>
                      ))}
                      <li className="flex justify-between border-t border-zinc-200 pt-1 font-medium">
                        <span>Tip</span>
                        <span>{$(tipCents)}</span>
                      </li>
                    </ul>
                  ) : (
                    <ul className="space-y-0.5 tabular">
                      {splitIds.map((id) => (
                        <li key={id} className="flex justify-between">
                          <span>{barberName(id)}</span>
                          <span>{$(shares.get(id) ?? 0)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
          </Card>

          <Card>
            <CardHeader title="Payment" />
            <div className="space-y-3 p-4">
              <div className="flex gap-2">
                <Input
                  placeholder="Gift card code"
                  value={giftInput}
                  onChange={(e) => setGiftInput(e.target.value.toUpperCase())}
                  className="uppercase"
                />
                {gift ? (
                  <Button variant="secondary" onClick={() => setGift(null)}>
                    Remove
                  </Button>
                ) : (
                  <Button
                    variant="secondary"
                    disabled={!giftInput || pending}
                    onClick={() =>
                      act(
                        () => giftCardAction(giftInput),
                        (g) =>
                          setGift({
                            code: g.code,
                            balanceCents: g.balanceCents,
                          }),
                      )
                    }
                  >
                    Apply
                  </Button>
                )}
              </div>
              {gift && (
                <div className="text-xs text-zinc-600">
                  Gift card {gift.code}: balance {$(gift.balanceCents)},
                  applying {$(totals.giftCardAppliedCents)}
                </div>
              )}
              {props.groupDeposit && !gift && (
                <div
                  className="flex items-center justify-between gap-2 rounded-lg bg-sky-50 px-3 py-2 text-sm text-sky-900 ring-1 ring-sky-200"
                  data-testid="group-deposit"
                >
                  <span>
                    Family booking {props.groupDeposit.groupCode}:{" "}
                    {$(props.groupDeposit.balanceCents)} deposit held
                  </span>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={pending}
                    onClick={() => {
                      const code = props.groupDeposit!.code;
                      setGiftInput(code);
                      act(
                        () => giftCardAction(code),
                        (g) =>
                          setGift({
                            code: g.code,
                            balanceCents: g.balanceCents,
                          }),
                      );
                    }}
                  >
                    Apply deposit
                  </Button>
                </div>
              )}

              {base.primaryBaseCents > 0 && (
                <div className="flex items-center justify-between text-xs">
                  <span className="text-zinc-500">
                    {split
                      ? `${parts.length} payments, ${$(base.primaryBaseCents)} before any surcharge`
                      : "One payment"}
                  </span>
                  <button
                    className="font-medium underline"
                    onClick={() => (split ? setSplitPay(false) : startSplit())}
                    data-testid="split-pay-toggle"
                  >
                    {split ? "One payment" : "Split payment"}
                  </button>
                </div>
              )}
              {split && plan && (
                <div className="space-y-2" data-testid="split-pay">
                  {parts.map((pt, i) => {
                    const pp = plan.parts[i];
                    return (
                      <div
                        key={pt.key}
                        className="space-y-2 rounded-lg p-2.5 ring-1 ring-zinc-200"
                        data-testid="split-part"
                      >
                        <div className="grid grid-cols-[auto_1fr_auto] items-center gap-2">
                          <div className="flex rounded-md bg-zinc-100 p-0.5 text-xs">
                            {(["cash", "card"] as const).map((m) => (
                              <button
                                key={m}
                                disabled={m === "card" && !props.payments.cards}
                                onClick={() =>
                                  setPart(pt.key, {
                                    method: m,
                                    card: m === "cash" ? null : pt.card,
                                  })
                                }
                                className={cx(
                                  "rounded px-2 py-1 font-medium capitalize disabled:opacity-40",
                                  pt.method === m
                                    ? "bg-white shadow-sm"
                                    : "text-zinc-600",
                                )}
                              >
                                {m}
                              </button>
                            ))}
                          </div>
                          <Input
                            className="py-1 text-right"
                            inputMode="decimal"
                            aria-label={`Payment ${i + 1} amount`}
                            value={pt.amount}
                            onChange={(e) =>
                              setPart(pt.key, { amount: e.target.value })
                            }
                          />
                          <button
                            className="text-xs text-zinc-400 hover:text-zinc-700"
                            onClick={() => restTo(pt.key)}
                            title="The rest of what's due"
                          >
                            Rest
                          </button>
                        </div>
                        <div className="grid grid-cols-[1fr_auto] items-center gap-2">
                          <select
                            aria-label={`Who pays payment ${i + 1}`}
                            className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs"
                            value={pt.payer}
                            onChange={(e) =>
                              setPart(pt.key, { payer: e.target.value })
                            }
                          >
                            <option value="">Paid by…</option>
                            {props.payers.map((p) => (
                              <option key={p.customerId} value={p.customerId}>
                                {p.name}
                              </option>
                            ))}
                            <option value="other">Someone else</option>
                          </select>
                          {parts.length > 2 && (
                            <button
                              className="text-xs text-zinc-400 hover:text-red-600"
                              onClick={() =>
                                setParts((ps) =>
                                  ps.filter((x) => x.key !== pt.key),
                                )
                              }
                            >
                              Remove
                            </button>
                          )}
                        </div>
                        {pt.payer === "other" && (
                          <Input
                            className="py-1 text-xs"
                            maxLength={PAYER_LABEL_MAX}
                            placeholder="Name (e.g. Grandma)"
                            value={pt.label}
                            onChange={(e) =>
                              setPart(pt.key, { label: e.target.value })
                            }
                          />
                        )}
                        {pt.method === "card" &&
                          (pt.card ? (
                            <div className="flex items-center justify-between text-xs">
                              <span>
                                <span className="font-medium capitalize">
                                  {pt.card.brand}
                                </span>{" "}
                                •••• {pt.card.last4}{" "}
                                <Badge
                                  tone={
                                    pt.card.funding === "credit"
                                      ? "amber"
                                      : "green"
                                  }
                                >
                                  {pt.card.funding}
                                </Badge>
                              </span>
                              <button
                                className="underline"
                                onClick={() => setPart(pt.key, { card: null })}
                              >
                                Change
                              </button>
                            </div>
                          ) : (
                            <div className="space-y-1.5">
                              <div className="flex gap-1 text-[11px]">
                                {(["terminal", "keyed"] as const).map((m) => (
                                  <button
                                    key={m}
                                    onClick={() =>
                                      setPart(pt.key, { cardMode: m })
                                    }
                                    className={cx(
                                      "rounded px-1.5 py-0.5",
                                      pt.cardMode === m
                                        ? "bg-zinc-900 text-white"
                                        : "bg-zinc-100 text-zinc-600",
                                    )}
                                  >
                                    {m === "terminal" ? "Reader" : "Key in"}
                                  </button>
                                ))}
                              </div>
                              {pt.cardMode === "keyed" &&
                              props.payments.publishableKey ? (
                                <StripeCardEntry
                                  publishableKey={props.payments.publishableKey}
                                  amountCents={pp?.chargeCents ?? 0}
                                  onPaymentMethod={(id) =>
                                    act(
                                      () => inspectCardAction(id),
                                      (c) =>
                                        setPart(pt.key, {
                                          card: { paymentMethodId: id, ...c },
                                        }),
                                    )
                                  }
                                />
                              ) : (
                                <div className="grid grid-cols-2 gap-1">
                                  {props.payments.testCards.map((tc) => (
                                    <button
                                      key={tc.id}
                                      disabled={pending}
                                      className="rounded px-1.5 py-1 text-left text-[11px] ring-1 ring-zinc-200 hover:bg-zinc-50"
                                      onClick={() =>
                                        act(
                                          () =>
                                            pt.cardMode === "terminal"
                                              ? terminalCollectAction(tc.id)
                                              : inspectCardAction(tc.id).then(
                                                  (r) =>
                                                    r.ok
                                                      ? {
                                                          ok: true as const,
                                                          data: {
                                                            paymentMethodId:
                                                              tc.id,
                                                            card: r.data,
                                                          },
                                                        }
                                                      : r,
                                                ),
                                          (d) =>
                                            setPart(pt.key, {
                                              card: {
                                                paymentMethodId:
                                                  d.paymentMethodId,
                                                ...d.card,
                                              },
                                            }),
                                        )
                                      }
                                    >
                                      {tc.label}
                                    </button>
                                  ))}
                                </div>
                              )}
                            </div>
                          ))}
                        {pp && (pp.tipCents > 0 || pp.feeCents > 0) && (
                          <div className="text-[11px] text-zinc-500">
                            {pp.tipCents > 0 &&
                              `Includes the ${$(pp.tipCents)} tip. `}
                            {pp.feeCents > 0 &&
                              `Charged ${$(pp.chargeCents)} with the ${$(pp.feeCents)} surcharge.`}
                          </div>
                        )}
                      </div>
                    );
                  })}
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span className="flex gap-3">
                      <button
                        className="font-medium underline"
                        onClick={splitEvenly}
                      >
                        Split evenly
                      </button>
                      {parts.length < MAX_SPLIT_TENDERS && (
                        <button
                          className="font-medium underline"
                          onClick={() =>
                            setParts((ps) => [...ps, newPart(0, "")])
                          }
                        >
                          Add a payment
                        </button>
                      )}
                    </span>
                    {splitProblem && (
                      <span className="text-right text-amber-700">
                        {splitProblem}
                      </span>
                    )}
                  </div>
                  {props.config.cardFee.enabled && (
                    <p className="text-[11px] text-zinc-500">
                      {props.feeNotice ??
                        "Credit cards carry the surcharge on their own part."}
                    </p>
                  )}
                </div>
              )}
              {base.primaryBaseCents > 0 && !split && (
                <div className="grid grid-cols-2 gap-2">
                  <TenderBtn
                    on={tender === "cash"}
                    onClick={() => setTender("cash")}
                    title="Cash"
                    sub={$(preview("cash", null).primaryChargeCents)}
                  />
                  <TenderBtn
                    on={tender === "card"}
                    disabled={!props.payments.cards}
                    onClick={() => setTender("card")}
                    title="Card"
                    sub={
                      !props.payments.cards
                        ? "Not available"
                        : props.config.cardFee.enabled
                          ? `${$(base.primaryChargeCents)} debit · ${$(creditPreview.primaryChargeCents)} credit`
                          : $(base.primaryChargeCents)
                    }
                  />
                </div>
              )}
              {base.primaryBaseCents > 0 && props.payments.noCards && (
                <p className="text-xs text-amber-800">
                  {props.payments.noCards}
                </p>
              )}

              {method === "cash" && (
                <div className="space-y-2">
                  <div className="text-xs font-medium text-zinc-700">
                    Cash tendered
                  </div>
                  <div className="grid grid-cols-4 gap-2">
                    {cashOptions(totals.primaryChargeCents).map((c) => (
                      <TipBtn
                        key={c}
                        on={cashTendered === c}
                        onClick={() => setCashTendered(c)}
                        big={
                          c === totals.primaryChargeCents ? "Exact" : $short(c)
                        }
                      />
                    ))}
                  </div>
                  {cashTendered != null && change >= 0 && (
                    <div className="rounded-lg bg-emerald-50 px-3 py-2 text-center text-emerald-900 ring-1 ring-emerald-200">
                      Change due{" "}
                      <span className="text-xl font-semibold tabular">
                        {$(change)}
                      </span>
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
                        className={cx(
                          "flex-1 rounded-md py-1.5 font-medium",
                          cardMode === m
                            ? "bg-white shadow-sm"
                            : "text-zinc-600",
                        )}
                      >
                        {m === "terminal" ? "Card reader" : "Key in card"}
                      </button>
                    ))}
                  </div>
                  {cardMode === "terminal" &&
                    props.payments.readers.length > 1 && (
                      <label className="flex items-center gap-2 text-xs text-zinc-600">
                        Reader
                        <select
                          className="rounded-md border border-zinc-200 px-2 py-1 text-sm"
                          value={readerId ?? ""}
                          onChange={(e) => setReaderId(e.target.value || null)}
                        >
                          {props.payments.readers.map((r) => (
                            <option key={r.id} value={r.id}>
                              {r.label}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                  {card ? (
                    <div className="flex items-center justify-between rounded-lg bg-zinc-50 px-3 py-2 ring-1 ring-zinc-200">
                      <div className="text-sm">
                        <span className="font-medium capitalize">
                          {card.brand}
                        </span>{" "}
                        •••• {card.last4}{" "}
                        <Badge
                          tone={card.funding === "credit" ? "amber" : "green"}
                        >
                          {card.funding}
                        </Badge>
                      </div>
                      <button
                        className="text-xs underline"
                        onClick={() => setCard(null)}
                      >
                        Change
                      </button>
                    </div>
                  ) : cardMode === "terminal" ||
                    !props.payments.publishableKey ? (
                    <div>
                      <div className="mb-2 text-xs text-zinc-500">
                        {cardMode === "terminal"
                          ? `${props.payments.terminalLabel}: tap a test card to "present" it.`
                          : "Simulator: no publishable key, so pick a Stripe test card."}
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        {props.payments.testCards.map((tc) => (
                          <button
                            key={tc.id}
                            disabled={pending}
                            onClick={() =>
                              act(
                                () =>
                                  cardMode === "terminal"
                                    ? terminalCollectAction(tc.id)
                                    : inspectCardAction(tc.id).then((r) =>
                                        r.ok
                                          ? {
                                              ok: true as const,
                                              data: {
                                                paymentMethodId: tc.id,
                                                card: r.data,
                                              },
                                            }
                                          : r,
                                      ),
                                (d) =>
                                  setCard({
                                    paymentMethodId: d.paymentMethodId,
                                    ...d.card,
                                  }),
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
                      onPaymentMethod={(id) =>
                        act(
                          () => inspectCardAction(id),
                          (c) => setCard({ paymentMethodId: id, ...c }),
                        )
                      }
                    />
                  )}
                  {props.feeNotice && (
                    <div className="text-xs text-zinc-500">
                      {props.feeNotice}
                    </div>
                  )}
                </div>
              )}
            </div>
          </Card>

          {props.timer && (
            <Card className="p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-xs font-medium text-zinc-700">
                    Service time
                  </div>
                  <div className="text-xs text-zinc-500">
                    {props.timer.times?.started && props.timer.times.finished
                      ? `${formatMinutes(props.timer.times.actualMin ?? 0)} (booked ${props.timer.times.bookedMin})`
                      : props.timer.times?.started
                        ? "Taking payment finishes the timer if you haven't."
                        : "Not started, so this cut won't be timed."}
                  </div>
                </div>
                <ServiceTimer
                  appointmentId={props.timer.appointmentId}
                  status={props.timer.status}
                  times={props.timer.times}
                />
              </div>
            </Card>
          )}

          {props.sale.hasAppointment &&
            !props.prompts?.enabled.rebook &&
            !props.prompts?.rebook && (
              <Card className="p-4">
                <div className="mb-2 text-xs font-medium text-zinc-700">
                  Rebook same barber, same time
                </div>
                <div className="grid grid-cols-5 gap-2">
                  {[null, 2, 3, 4, 6].map((w) => (
                    <button
                      key={w ?? 0}
                      onClick={() => setRebookWeeks(w)}
                      className={cx(
                        "h-10 rounded-lg text-sm font-medium ring-1",
                        rebookWeeks === w
                          ? "bg-ink-900 text-white ring-ink-900"
                          : "bg-white ring-zinc-300 hover:bg-zinc-50",
                      )}
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
              {totals.productGrossCents > 0 && (
                <Row k="Products" v={$(totals.productGrossCents)} />
              )}
              {totals.giftCardSalesCents > 0 && (
                <Row k="Gift cards sold" v={$(totals.giftCardSalesCents)} />
              )}
              {totals.discountBreakdown.map((d, i) => (
                <Row
                  key={i}
                  k={d.label}
                  v={$(-d.cents)}
                  className="text-emerald-700"
                />
              ))}
              <Row
                k={`Tax (services ${(props.config.taxRates.serviceRate * 100).toFixed(2)}%)`}
                v={$(totals.serviceTaxCents)}
              />
              {totals.productNetCents > 0 && (
                <Row
                  k={`Tax (products ${(props.config.taxRates.productRate * 100).toFixed(2)}%)`}
                  v={$(totals.productTaxCents)}
                />
              )}
              <Row k="Tip" v={$(totals.tipCents)} />
              {totals.cardFeeCents > 0 && (
                <Row
                  k={feeLabel({ rate: totals.cardFeeRate })}
                  v={$(totals.cardFeeCents)}
                  className="text-amber-700"
                />
              )}
              {totals.giftCardAppliedCents > 0 && (
                <Row k="Gift card" v={$(-totals.giftCardAppliedCents)} />
              )}
              <div className="flex items-baseline justify-between border-t border-zinc-200 pt-2">
                <dt className="font-semibold">
                  {totals.giftCardAppliedCents > 0 ? "Due now" : "Total"}
                </dt>
                <dd className="text-2xl font-semibold">
                  {$(totals.primaryChargeCents)}
                </dd>
              </div>
              {totals.loyaltyEligibleCents > 0 && props.customer && (
                <div className="pt-1 text-xs text-zinc-500">
                  Earns {$(totals.loyaltyEligibleCents)} toward loyalty.
                </div>
              )}
            </dl>
            <div className="space-y-2 border-t border-zinc-100 p-4">
              {error && <Notice tone="red">{error}</Notice>}
              {msg && <Notice tone="green">{msg}</Notice>}
              {waitingMsg && <Notice tone="amber">{waitingMsg}</Notice>}
              <Button
                size="lg"
                variant="secondary"
                className="h-14 w-full text-lg"
                disabled={
                  !!props.withClient ||
                  lines.length === 0 ||
                  pending ||
                  waiting.length > 0
                }
                onClick={() => (setMsg(null), handToCustomer())}
                data-testid="hand-to-customer"
              >
                Hand to customer
              </Button>
              <p className="text-xs text-zinc-500">
                The client picks a tip{props.handoff.signature ? ", signs" : ""}
                , chooses a receipt and pays on this device. It locks to this
                ticket until a{" "}
                {props.handoff.unlock === "manager" ? "manager's" : "staff"}{" "}
                PIN.
              </p>
              <Button
                size="lg"
                className="h-14 w-full text-lg"
                disabled={!ready || pending}
                onClick={() => (setMsg(null), charge())}
              >
                {pending
                  ? "Processing…"
                  : split
                    ? (splitProblem ??
                      (parts.every((p) => p.method === "cash" || p.card)
                        ? `Take ${$(totals.primaryChargeCents)} in ${parts.length} payments`
                        : "Read each card first"))
                    : method === "none"
                      ? !lines.length
                        ? "Add items"
                        : base.primaryBaseCents > 0
                          ? "Choose cash or card"
                          : gift
                            ? "Complete (paid by gift card)"
                            : "Complete"
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
  return [...set]
    .filter((c) => c >= due)
    .sort((a, b) => a - b)
    .slice(0, 4);
}

function Row({
  k,
  v,
  className,
}: {
  k: string;
  v: string;
  className?: string;
}) {
  return (
    <div className={cx("flex justify-between", className)}>
      <dt className="text-zinc-600">{k}</dt>
      <dd>{v}</dd>
    </div>
  );
}

function TipBtn({
  on,
  onClick,
  big,
  small,
}: {
  on: boolean;
  onClick: () => void;
  big: string;
  small?: string;
}) {
  return (
    <button
      onClick={onClick}
      className={cx(
        "flex h-12 flex-col items-center justify-center rounded-lg ring-1 transition",
        on
          ? "bg-ink-900 text-white ring-ink-900"
          : "bg-white ring-zinc-300 hover:bg-zinc-50",
      )}
    >
      <span className="text-sm font-semibold">{big}</span>
      {small && (
        <span
          className={cx(
            "text-[11px] tabular",
            on ? "text-zinc-300" : "text-zinc-500",
          )}
        >
          {small}
        </span>
      )}
    </button>
  );
}

function TenderBtn({
  on,
  onClick,
  title,
  sub,
  disabled,
}: {
  on: boolean;
  onClick: () => void;
  title: string;
  sub: string;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cx(
        "rounded-xl px-3 py-3 text-left ring-1 transition disabled:cursor-not-allowed disabled:opacity-50",
        on
          ? "bg-brand-600 text-white ring-brand-600"
          : "bg-white ring-zinc-300 hover:bg-zinc-50",
      )}
    >
      <div className="font-semibold">{title}</div>
      <div
        className={cx(
          "text-xs tabular",
          on ? "text-white/80" : "text-zinc-500",
        )}
      >
        {sub}
      </div>
    </button>
  );
}

type PosCustomer = {
  id: string;
  name: string;
  phone: string | null;
  rating: RatingSummary | null;
  badges: ShownBadge[];
  /** Pinned notes and the last cut, as they may see them. */
  clientNotes: NoteBrief | null;
  /** They may write a cut note for this visit. */
  cutNote: { appointmentId: string | null } | null;
};

/** Writing down this visit's cut at checkout: guard numbers, style, products and anything else. */
function QuickCutNote({
  customerId,
  appointmentId,
  onError,
}: {
  customerId: string;
  appointmentId: string | null;
  onError: (e: string) => void;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [d, setD] = useState({ guard: "", style: "", products: "", body: "" });
  const [done, setDone] = useState<string | null>(null);
  const warn = contactWarning(
    contactPatterns([d.guard, d.style, d.products, d.body].join("\n")),
  );
  if (!open)
    return (
      <div className="mt-1 flex items-center gap-2 text-xs">
        <button
          type="button"
          className="underline"
          onClick={() => (setOpen(true), setDone(null))}
        >
          Add cut note for this visit
        </button>
        {done && <span className="text-emerald-700">{done}</span>}
      </div>
    );
  const save = () =>
    start(async () => {
      const r = await addNoteAction(customerId, {
        kind: "visit",
        body: d.body,
        appointmentId,
        details: {
          guard: d.guard,
          style: d.style,
          products: d.products
            .split(",")
            .map((x) => x.trim())
            .filter(Boolean),
        },
      });
      if (!r.ok) return onError(r.error);
      setOpen(false);
      setD({ guard: "", style: "", products: "", body: "" });
      setDone(
        r.data.removed.length
          ? "Saved. Contact details were taken out."
          : "Cut note saved",
      );
      router.refresh();
    });
  return (
    <div
      className="mt-2 space-y-1.5 rounded-lg bg-zinc-50 p-2 text-sm ring-1 ring-zinc-200"
      data-testid="quick-cut-note"
    >
      <div className="grid grid-cols-2 gap-1.5">
        <Input
          placeholder="Guard numbers"
          value={d.guard}
          maxLength={80}
          onChange={(e) => setD({ ...d, guard: e.target.value })}
        />
        <Input
          placeholder="Style"
          value={d.style}
          maxLength={120}
          onChange={(e) => setD({ ...d, style: e.target.value })}
        />
        <Input
          className="col-span-2"
          placeholder="Products used, separated by commas"
          value={d.products}
          onChange={(e) => setD({ ...d, products: e.target.value })}
        />
        <Input
          className="col-span-2"
          placeholder="Anything else"
          value={d.body}
          maxLength={2000}
          onChange={(e) => setD({ ...d, body: e.target.value })}
        />
      </div>
      {warn && (
        <p
          role="alert"
          className="rounded bg-amber-50 px-2 py-1 text-xs text-amber-800"
        >
          {warn}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => setOpen(false)}
        >
          Cancel
        </Button>
        <Button type="button" size="sm" disabled={pending} onClick={save}>
          Save cut note
        </Button>
      </div>
    </div>
  );
}

function CustomerBox({
  saleId,
  customer,
  canAdd,
  onError,
}: {
  saleId: string;
  customer: PosCustomer | null;
  canAdd: { phone: boolean; email: boolean };
  onError: (e: string) => void;
}) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({
    firstName: "",
    lastName: "",
    phone: "",
    email: "",
  });
  const set = (k: keyof typeof draft) => (e: ChangeEvent<HTMLInputElement>) =>
    setDraft((d) => ({ ...d, [k]: e.target.value }));
  const create = async (e: FormEvent) => {
    e.preventDefault();
    const r = await newClientAtCheckoutAction(saleId, draft);
    if (!r.ok) return onError(r.error);
    setAdding(false);
    setDraft({ firstName: "", lastName: "", phone: "", email: "" });
    router.refresh();
  };
  const [found, setFound] = useState<ClientHit[]>([]);
  useEffect(() => {
    if (q.trim().length < 2) return setFound([]);
    const t = setTimeout(async () => {
      const r = await searchCustomersAction(q, "pos");
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
              <a
                className="truncate font-medium hover:underline"
                href={`/admin/customers/${customer.id}`}
              >
                {customer.name}
              </a>
              <StarBadge rating={customer.rating} />
            </span>
            <button className="text-xs underline" onClick={() => attach(null)}>
              Remove
            </button>
          </div>
          <ClientBadges
            badges={customer.badges}
            strongActions
            className="mt-1 flex"
          />
          <ClientNotesBrief
            brief={customer.clientNotes}
            customerId={customer.id}
            compact
            className="mt-1 text-xs"
          />
          {customer.cutNote && (
            <QuickCutNote
              customerId={customer.id}
              appointmentId={customer.cutNote.appointmentId}
              onError={onError}
            />
          )}
        </>
      ) : adding ? (
        <form
          onSubmit={create}
          className="space-y-2 rounded-lg p-2 ring-1 ring-zinc-200"
        >
          <div className="grid grid-cols-2 gap-2">
            <Input
              placeholder="First name"
              value={draft.firstName}
              onChange={set("firstName")}
              required
              autoFocus
            />
            <Input
              placeholder="Last name"
              value={draft.lastName}
              onChange={set("lastName")}
            />
            {canAdd.phone && (
              <Input
                className="col-span-2"
                placeholder="Mobile"
                inputMode="tel"
                value={draft.phone}
                onChange={set("phone")}
              />
            )}
            {canAdd.email && (
              <Input
                className="col-span-2"
                placeholder="Email"
                type="email"
                value={draft.email}
                onChange={set("email")}
              />
            )}
          </div>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setAdding(false)}
            >
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
            <Input
              placeholder="Name, phone, card, gift card… (for loyalty)"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            <Button
              type="button"
              variant="secondary"
              onClick={() => setAdding(true)}
            >
              New client
            </Button>
          </div>
          {found.length > 0 && (
            <div className="absolute inset-x-0 z-10 mt-1 divide-y divide-zinc-100 rounded-lg bg-white shadow-lg ring-1 ring-zinc-200">
              <FamilyPickList hits={found} onPick={(_, id) => attach(id)} />
            </div>
          )}
        </>
      )}
    </div>
  );
}

function PeopleCard(props: {
  saleId: string;
  people: Person[];
  family: { members: FamilyMember[]; candidates: FamilyMember[] };
  canCombine: boolean;
  pending: boolean;
  act: Act;
  onChanged: () => void;
}) {
  const at = (iso: string) =>
    new Date(iso).toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
    });
  const [picking, setPicking] = useState(false);
  const [q, setQ] = useState("");
  const [found, setFound] = useState<Awaited<
    ReturnType<typeof searchTicketsAction>
  > | null>(null);
  const r = readiness(props.people);
  const lead = props.people[0]?.appointmentId;
  const isFamily = (id: string) =>
    props.family.members.some((m) => m.appointmentId === id);
  const search = (text: string) =>
    searchTicketsAction(props.saleId, text).then(setFound);
  useEffect(() => {
    if (!picking) return;
    const t = setTimeout(() => search(q), 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picking, q]);
  const done = () => {
    setFound(null);
    props.onChanged();
  };
  return (
    <Card data-testid="ticket-people">
      <CardHeader
        title={
          props.people.length > 1
            ? `${props.people.length} people on this ticket`
            : "Combine tickets"
        }
        subtitle={
          props.people.length > 1
            ? `${r.ready} of ${r.total} sent to checkout. Each line stays with its person and barber; one payment or split.`
            : "Pay for someone else's visit too: siblings who walked in apart, a friend's cut."
        }
      />
      {props.people.length > 1 && (
        <ul className="divide-y divide-zinc-100">
          {props.people.map((m) => (
            <li
              key={m.appointmentId}
              className="flex items-center gap-3 px-4 py-2"
              data-testid="ticket-person"
            >
              <span
                className={cx(
                  "h-2.5 w-2.5 shrink-0 rounded-full",
                  m.readyAt ? "bg-emerald-500" : "bg-zinc-300",
                )}
                title={m.readyAt ? "Sent to checkout" : "Not sent yet"}
              />
              <div className="min-w-0 flex-1 text-sm">
                <span className="font-medium">{m.name}</span>
                {m.isChild && (
                  <Badge tone="violet" className="ml-1.5">
                    Kid
                  </Badge>
                )}
                {m.appointmentId === lead && (
                  <span className="ml-1.5 text-xs text-zinc-500">
                    ticket&apos;s own visit
                  </span>
                )}
                <div className="text-xs text-zinc-500">
                  {m.staffName ? `with ${m.staffName}` : "No barber"}
                  {m.readyAt ? ` · ready ${at(m.readyAt)}` : ""}
                </div>
              </div>
              {props.canCombine && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={props.pending}
                  onClick={() =>
                    props.act(
                      () => splitOffAction(props.saleId, m.appointmentId),
                      done,
                    )
                  }
                  data-testid="split-off"
                >
                  Own ticket
                </Button>
              )}
              {isFamily(m.appointmentId) && (
                <button
                  className="text-xs text-zinc-400 hover:text-red-600"
                  disabled={props.pending}
                  onClick={() =>
                    props.act(
                      () =>
                        removeFamilyFromTicketAction(
                          props.saleId,
                          m.appointmentId,
                        ),
                      done,
                    )
                  }
                >
                  Take off
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {props.family.candidates.length > 0 && (
        <ul className="divide-y divide-zinc-100 border-t border-zinc-100">
          {props.family.candidates.map((m) => (
            <li
              key={m.appointmentId}
              className="flex items-center gap-3 px-4 py-2"
            >
              <div className="min-w-0 flex-1 text-sm">
                <span className="font-medium">{m.name}</span>
                {m.isChild && (
                  <Badge tone="violet" className="ml-1.5">
                    Kid
                  </Badge>
                )}
                <div className="text-xs text-zinc-500">
                  Family · {at(m.startsAt)}
                  {m.staffName ? ` with ${m.staffName}` : ""}
                </div>
              </div>
              <Button
                size="sm"
                variant="secondary"
                disabled={props.pending}
                onClick={() =>
                  props.act(
                    () =>
                      addFamilyToTicketAction(props.saleId, m.appointmentId),
                    done,
                  )
                }
              >
                Add to ticket
              </Button>
            </li>
          ))}
        </ul>
      )}
      {props.canCombine && (
        <div className="space-y-2 border-t border-zinc-100 p-3">
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setPicking((v) => !v)}
              data-testid="add-ticket"
            >
              {picking ? "Done adding" : "Add ticket"}
            </Button>
            {props.people.length > 1 && (
              <Button
                size="sm"
                variant="ghost"
                disabled={props.pending}
                onClick={() =>
                  confirm("Give everyone their own ticket?") &&
                  props.act(() => splitApartAction(props.saleId), done)
                }
              >
                Split everyone
              </Button>
            )}
          </div>
          {picking && (
            <div className="space-y-2">
              <Input
                autoFocus
                placeholder="Ticket # or anyone's name"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                aria-label="Find an open ticket"
              />
              {found && !found.ok && (
                <p className="text-xs text-red-700">{found.error}</p>
              )}
              {found?.ok && found.data.length === 0 && (
                <p className="text-xs text-zinc-500">
                  No other open tickets{q ? " match" : " at this shop"}.
                </p>
              )}
              {found?.ok && found.data.length > 0 && (
                <ul className="max-h-64 divide-y divide-zinc-100 overflow-y-auto rounded-lg ring-1 ring-zinc-200">
                  {found.data.map((t) => (
                    <li
                      key={t.id}
                      className="flex items-center gap-2 px-3 py-2 text-sm"
                      data-testid="ticket-hit"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="font-medium">
                          #{t.number} · {t.client ?? "Walk-in"}
                          {t.groupCode && (
                            <span className="ml-1 font-mono text-xs text-zinc-500">
                              {t.groupCode}
                            </span>
                          )}
                        </div>
                        <div className="truncate text-xs text-zinc-500">
                          {t.people.length
                            ? t.people
                                .map(
                                  (p) =>
                                    `${p.name}${p.staffName ? ` (${p.staffName})` : ""}`,
                                )
                                .join(", ")
                            : (t.barber ?? "No barber")}
                          {t.total > 0 && ` · ${t.ready} of ${t.total} ready`} ·{" "}
                          {$(t.grossCents)}
                        </div>
                      </div>
                      <Button
                        size="sm"
                        disabled={props.pending}
                        onClick={() =>
                          props.act(
                            () => mergeTicketsAction(props.saleId, [t.id]),
                            done,
                          )
                        }
                      >
                        Combine
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
