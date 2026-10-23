/**
 * Customer hand-off at checkout: the device is turned to the client for the tip, an optional
 * signature, the receipt and payment, locked to that ticket until a staff PIN takes it back.
 * Tip presets are the brand's, or the location's own; everything else is per location.
 */

export const TIP_PRESET_TYPES = ["percent", "amount"] as const;
export type TipPresetType = (typeof TIP_PRESET_TYPES)[number];

export interface TipScreen {
  type: TipPresetType;
  /** Whole percents, or cents. Up to four, shown in this order. */
  values: number[];
  allowCustom: boolean;
  allowNoTip: boolean;
}

export const MAX_TIP_PRESETS = 4;
export const MAX_AMOUNT_PRESET_CENTS = 50_000;
/** The most a client can tip on the customer screen. A bigger tip is entered by staff. */
export const MAX_SCREEN_TIP_CENTS = 50_000;
export const DEFAULT_TIP_SCREEN: TipScreen = { type: "percent", values: [20, 25, 30], allowCustom: true, allowNoTip: true };

export const TIP_ENTRY = ["screen", "reader"] as const;
/** screen: the client tips on this device. reader: the Stripe Terminal reader asks for the tip when the card is presented. */
export type TipEntry = (typeof TIP_ENTRY)[number];
export const UNLOCK_RULES = ["staff", "manager"] as const;
/** Whose PIN takes the device back: anyone who works at the shop, or a manager (the "Unlock a handed-off device" permission). */
export type UnlockRule = (typeof UNLOCK_RULES)[number];
export const AFTER_PAYMENT = ["auto", "pin"] as const;
/** auto: after the thank-you screen the device goes back to staff by itself. pin: it waits for a PIN. */
export type AfterPayment = (typeof AFTER_PAYMENT)[number];

export interface ShopHandoff {
  /** This location's own presets; null uses the brand's. */
  tips: TipScreen | null;
  tipEntry: TipEntry;
  signature: boolean;
  unlock: UnlockRule;
  afterPayment: AfterPayment;
  thankYouSeconds: number;
}

export interface BrandHandoff {
  tips: TipScreen;
}

export const THANK_YOU_SECONDS = { min: 3, max: 60 } as const;
export const DEFAULT_SHOP_HANDOFF: ShopHandoff = { tips: null, tipEntry: "screen", signature: false, unlock: "staff", afterPayment: "auto", thankYouSeconds: 8 };

const obj = (raw: unknown): Record<string, unknown> => (raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {});
const pick = <T extends string>(v: unknown, list: readonly T[], d: T): T => (list.includes(v as T) ? (v as T) : d);

export function tipScreenProblem(t: TipScreen): string | null {
  if (!t.values.length) return "Add at least one tip preset";
  if (t.values.length > MAX_TIP_PRESETS) return `Up to ${MAX_TIP_PRESETS} tip presets`;
  if (new Set(t.values).size !== t.values.length) return "Each tip preset must be different";
  if (t.type === "percent" && t.values.some((v) => !Number.isInteger(v) || v < 1 || v > 100)) return "Percent presets are whole numbers from 1 to 100";
  if (t.type === "amount" && t.values.some((v) => !Number.isInteger(v) || v < 100 || v > MAX_AMOUNT_PRESET_CENTS)) return "Dollar presets are from $1 to $500, in whole cents";
  return null;
}

/** Stored presets, or null when they're missing or no longer valid. */
export function tipScreen(raw: unknown): TipScreen | null {
  const o = obj(raw);
  if (!Array.isArray(o.values)) return null;
  const t: TipScreen = {
    type: pick(o.type, TIP_PRESET_TYPES, "percent"),
    values: o.values.filter((v): v is number => typeof v === "number"),
    allowCustom: o.allowCustom !== false,
    allowNoTip: o.allowNoTip !== false,
  };
  return tipScreenProblem(t) ? null : t;
}

export function brandHandoff(raw: unknown): BrandHandoff {
  return { tips: tipScreen(obj(raw).tips) ?? DEFAULT_TIP_SCREEN };
}

export function shopHandoff(raw: unknown): ShopHandoff {
  const o = obj(raw);
  const secs = typeof o.thankYouSeconds === "number" && Number.isFinite(o.thankYouSeconds) ? Math.round(o.thankYouSeconds) : DEFAULT_SHOP_HANDOFF.thankYouSeconds;
  return {
    tips: tipScreen(o.tips),
    tipEntry: pick(o.tipEntry, TIP_ENTRY, DEFAULT_SHOP_HANDOFF.tipEntry),
    signature: o.signature === true,
    unlock: pick(o.unlock, UNLOCK_RULES, DEFAULT_SHOP_HANDOFF.unlock),
    afterPayment: pick(o.afterPayment, AFTER_PAYMENT, DEFAULT_SHOP_HANDOFF.afterPayment),
    thankYouSeconds: Math.min(THANK_YOU_SECONDS.max, Math.max(THANK_YOU_SECONDS.min, secs)),
  };
}

export function shopHandoffProblem(s: ShopHandoff): string | null {
  if (s.tips) {
    const p = tipScreenProblem(s.tips);
    if (p) return p;
  }
  if (!Number.isInteger(s.thankYouSeconds) || s.thankYouSeconds < THANK_YOU_SECONDS.min || s.thankYouSeconds > THANK_YOU_SECONDS.max)
    return `The thank-you screen shows for ${THANK_YOU_SECONDS.min} to ${THANK_YOU_SECONDS.max} seconds`;
  return null;
}

export const effectiveTips = (shop: ShopHandoff, brand: BrandHandoff): TipScreen => shop.tips ?? brand.tips;

/** Percent presets are of the services before discounts, as at the counter. */
export interface TipChoice {
  key: string;
  label: string;
  /** The dollar amount under a percent button. */
  detail: string | null;
  cents: number;
}

const short = (c: number) => `$${(c / 100).toFixed(c % 100 ? 2 : 0)}`;

export function tipChoices(t: TipScreen, serviceGrossCents: number): TipChoice[] {
  return t.values
    .map((v) => {
      if (t.type === "amount") return { key: `a${v}`, label: short(v), detail: null, cents: v };
      const cents = Math.round((serviceGrossCents * v) / 100);
      return { key: `p${v}`, label: `${v}%`, detail: short(cents), cents };
    })
    .filter((c) => c.cents > 0);
}

/** A tip typed on the customer screen. Asks the client to confirm one over half the services. */
export function screenTipProblem(cents: number): string | null {
  if (!Number.isInteger(cents) || cents < 0) return "Enter a tip of $0 or more";
  if (cents > MAX_SCREEN_TIP_CENTS) return `Tips over ${short(MAX_SCREEN_TIP_CENTS)} are entered at the counter`;
  return null;
}
export const bigTip = (cents: number, serviceGrossCents: number) => cents > 2000 && cents > serviceGrossCents / 2;

// ───────────────────────────── Steps ─────────────────────────────

export type HandoffStep = "tip" | "signature" | "receipt" | "pay" | "done";

/**
 * The client's screens in order. Tips on the reader skip the tip screen when the client pays on a
 * reader; with no reader at the shop, or paying another way, the tip is asked for here.
 */
export function handoffSteps(cfg: Pick<ShopHandoff, "tipEntry" | "signature">, o: { readerTips: boolean }): HandoffStep[] {
  const steps: HandoffStep[] = [];
  if (!(cfg.tipEntry === "reader" && o.readerTips)) steps.push("tip");
  if (cfg.signature) steps.push("signature");
  steps.push("receipt", "pay", "done");
  return steps;
}

// ───────────────────────────── Split tips ─────────────────────────────

export const TIP_SPLIT_MODES = ["services", "even"] as const;
/** services: in proportion to each barber's services on the ticket. even: the same for each. */
export type TipSplitMode = (typeof TIP_SPLIT_MODES)[number];

/**
 * Whole cents to each id in proportion to its weight, largest remainder first (ties to the lower
 * id), so the parts always add up. The tip_split_shares view in the database does the same.
 */
export function splitCents(total: number, weights: readonly { id: string; weight: number }[]): Map<string, number> {
  const out = new Map<string, number>();
  const sum = weights.reduce((a, w) => a + w.weight, 0);
  if (!weights.length || sum <= 0) return out;
  const parts = weights.map((w) => ({ id: w.id, base: Math.floor((total * w.weight) / sum), rem: (total * w.weight) % sum }));
  let left = total - parts.reduce((a, p) => a + p.base, 0);
  const order = [...parts].sort((a, b) => b.rem - a.rem || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const p of order) {
    out.set(p.id, p.base + (left > 0 ? 1 : 0));
    if (left > 0) left--;
  }
  return out;
}

/** Each barber's weight for a split ticket: their services' net, or one each. All zero falls back to even. */
export function tipWeights(lines: readonly { kind: string; staffId?: string | null; netCents: number }[], mode: TipSplitMode): { staffId: string; weight: number }[] {
  const by = new Map<string, number>();
  for (const l of lines) if ((l.kind === "service" || l.kind === "addon") && l.staffId) by.set(l.staffId, (by.get(l.staffId) ?? 0) + Math.max(0, l.netCents));
  const ids = [...by.keys()].sort();
  const even = mode === "even" || ids.every((id) => by.get(id) === 0);
  return ids.map((staffId) => ({ staffId, weight: even ? 1 : by.get(staffId)! }));
}

/** The barbers on a ticket's services, when it's more than the ticket's own barber. */
export function splitBarbers(lines: readonly { kind: string; staffId?: string | null }[], leadId: string | null): string[] {
  const ids = [...new Set(lines.filter((l) => (l.kind === "service" || l.kind === "addon") && l.staffId).map((l) => l.staffId!))].sort();
  return ids.length > 1 || (ids.length === 1 && ids[0] !== leadId) ? ids : [];
}

// ───────────────────────────── Signature and receipt ─────────────────────────────

/** A signature is SVG path data in a 600×200 box: moves and lines with whole coordinates. */
export const SIGNATURE_MAX_LENGTH = 20_000;
export function signatureProblem(path: string): string | null {
  if (!path.trim()) return "Sign in the box";
  if (path.length > SIGNATURE_MAX_LENGTH) return "That signature is too long. Clear it and sign again.";
  if (!/^[ML0-9 .-]+$/.test(path)) return "That isn't a signature";
  if ((path.match(/L/g) ?? []).length < 3) return "Sign in the box";
  return null;
}

export const RECEIPT_CHANNELS = ["sms", "email", "none"] as const;
export type ReceiptChannel = (typeof RECEIPT_CHANNELS)[number];
