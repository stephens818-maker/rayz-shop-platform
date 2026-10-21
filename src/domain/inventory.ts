/**
 * Inventory and purchasing rules. Pure: levels, stock positions, suggested orders, purchase order
 * states, receiving and counts. Server code loads the rows, calls these, and posts to the ledger.
 */

// ───────────────────────────── Levels ─────────────────────────────

export interface Levels {
  /** Low stock at or below this. */
  reorderPoint: number;
  /** Suggested orders fill up to this. Never below the reorder point. */
  par: number;
}

/** A shop's levels: its own override where it has one, the brand default otherwise. */
export function effectiveLevels(brand: { lowStockThreshold: number; parLevel: number }, shop?: { lowStockThreshold: number | null; parLevel: number | null } | null): Levels {
  const reorderPoint = shop?.lowStockThreshold ?? brand.lowStockThreshold;
  return { reorderPoint, par: Math.max(shop?.parLevel ?? brand.parLevel, reorderPoint) };
}

export function levelsProblem(reorderPoint: number, par: number): string | null {
  if (![reorderPoint, par].every((n) => Number.isInteger(n) && n >= 0 && n <= 100_000)) return "Par and reorder point are whole numbers, zero or more";
  if (par < reorderPoint) return "Par can't be below the reorder point";
  return null;
}

// ───────────────────────────── Stock position ─────────────────────────────

export interface Position {
  onHand: number;
  /** On open tickets and in transfers that haven't left yet. */
  committed: number;
  /** Ordered from vendors and not yet received. */
  onOrder: number;
  /** Sent from another shop and not yet received here. */
  inTransit: number;
}

export const availableQty = (p: Pick<Position, "onHand" | "committed">) => p.onHand - p.committed;
/** What the shop will have once everything ordered arrives. */
export const projectedQty = (p: Position) => availableQty(p) + p.onOrder + p.inTransit;
export const isLow = (p: Pick<Position, "onHand" | "committed">, l: Pick<Levels, "reorderPoint">) => availableQty(p) <= l.reorderPoint;

// ───────────────────────────── Suggested orders ─────────────────────────────

export const roundToCase = (qty: number, casePack: number) => {
  const c = Math.max(1, Math.floor(casePack) || 1);
  return Math.ceil(qty / c) * c;
};

/**
 * Units to order: nothing while the projected stock is above the reorder point; otherwise enough
 * to reach par (at least one over the reorder point), rounded up to whole cases.
 */
export function suggestQty(p: Position, l: Levels, casePack = 1): number {
  const projected = projectedQty(p);
  if (projected > l.reorderPoint) return 0;
  return roundToCase(Math.max(l.par, l.reorderPoint + 1) - projected, casePack);
}

export interface VendorOffer {
  vendorId: string;
  vendorName: string;
  vendorSku: string | null;
  casePack: number;
  costCents: number;
  preferred: boolean;
}

/** The preferred vendor, else the cheapest, then by name. */
export function pickVendor<T extends VendorOffer>(offers: T[]): T | null {
  return [...offers].sort((a, b) => Number(b.preferred) - Number(a.preferred) || a.costCents - b.costCents || a.vendorName.localeCompare(b.vendorName))[0] ?? null;
}

export interface SuggestItem {
  productId: string;
  sku: string;
  name: string;
  position: Position;
  levels: Levels;
  offers: VendorOffer[];
}

export interface SuggestedLine {
  productId: string;
  sku: string;
  name: string;
  vendorSku: string | null;
  casePack: number;
  qty: number;
  cases: number;
  unitCostCents: number;
  projected: number;
  position: Position;
  levels: Levels;
}

export interface SuggestedOrder {
  vendorId: string;
  vendorName: string;
  lines: SuggestedLine[];
  totalCents: number;
  minimumOrderCents: number;
  belowMinimum: boolean;
}

/** One suggested order per vendor for everything due, and what's due but has no vendor. */
export function suggestOrders(items: SuggestItem[], vendorMinimums: Record<string, number> = {}): { orders: SuggestedOrder[]; noVendor: Omit<SuggestedLine, "vendorSku" | "unitCostCents">[] } {
  const byVendor = new Map<string, SuggestedOrder>();
  const noVendor: Omit<SuggestedLine, "vendorSku" | "unitCostCents">[] = [];
  for (const it of items) {
    const offer = pickVendor(it.offers);
    const casePack = offer?.casePack ?? 1;
    const qty = suggestQty(it.position, it.levels, casePack);
    if (qty <= 0) continue;
    const base = { productId: it.productId, sku: it.sku, name: it.name, casePack, qty, cases: qty / Math.max(1, casePack), projected: projectedQty(it.position), position: it.position, levels: it.levels };
    if (!offer) {
      noVendor.push(base);
      continue;
    }
    const min = vendorMinimums[offer.vendorId] ?? 0;
    const o = byVendor.get(offer.vendorId) ?? { vendorId: offer.vendorId, vendorName: offer.vendorName, lines: [], totalCents: 0, minimumOrderCents: min, belowMinimum: false };
    o.lines.push({ ...base, vendorSku: offer.vendorSku, unitCostCents: offer.costCents });
    o.totalCents += qty * offer.costCents;
    byVendor.set(offer.vendorId, o);
  }
  const orders = [...byVendor.values()].map((o) => ({ ...o, lines: o.lines.sort((a, b) => a.name.localeCompare(b.name)), belowMinimum: o.totalCents < o.minimumOrderCents }));
  return { orders: orders.sort((a, b) => a.vendorName.localeCompare(b.vendorName)), noVendor: noVendor.sort((a, b) => a.name.localeCompare(b.name)) };
}

// ───────────────────────────── Purchase orders ─────────────────────────────

export const PO_STATUSES = ["draft", "approved", "sent", "partially_received", "received", "cancelled"] as const;
export type PoStatus = (typeof PO_STATUSES)[number];
export const PO_STATUS_LABEL: Record<PoStatus, string> = {
  draft: "Draft",
  approved: "Approved",
  sent: "Sent",
  partially_received: "Partially received",
  received: "Received",
  cancelled: "Cancelled",
};
/** Counted as on order. Drafts aren't ordered yet. */
export const OPEN_PO_STATUSES: PoStatus[] = ["approved", "sent", "partially_received"];

export const poNumber = (n: number | null | undefined) => `PO-${n ?? "?"}`;
export const transferNumber = (n: number | null | undefined) => `TR-${n ?? "?"}`;
export const countNumber = (n: number | null | undefined) => `C-${n ?? "?"}`;

export const poTotalCents = (lines: { qtyOrdered: number; unitCostCents: number }[]) => lines.reduce((a, l) => a + l.qtyOrdered * l.unitCostCents, 0);

/** Above the brand's limit (if it has one) a purchase order needs approval before it's sent. */
export const needsApproval = (totalCents: number, thresholdCents: number | null | undefined) => thresholdCents !== null && thresholdCents !== undefined && totalCents > thresholdCents;

export type PoAction = "edit" | "approve" | "send" | "receive" | "cancel" | "close";

export function poActionProblem(status: PoStatus, action: PoAction, o: { lines: number; overLimit: boolean } = { lines: 1, overLimit: false }): string | null {
  const label = PO_STATUS_LABEL[status].toLowerCase();
  switch (action) {
    case "edit":
      return status === "draft" || status === "approved" ? null : `A ${label} purchase order can't be edited`;
    case "approve":
      if (status !== "draft") return `Only drafts are approved; this one is ${label}`;
      return o.lines ? null : "Add at least one line first";
    case "send":
      if (status !== "draft" && status !== "approved") return `This purchase order is already ${label}`;
      if (!o.lines) return "Add at least one line first";
      return status === "draft" && o.overLimit ? "This order is over the approval limit, so it needs approval before it's sent" : null;
    case "receive":
      return status === "sent" || status === "partially_received" ? null : status === "received" ? "Everything on this order has been received" : `Send the order before receiving against it (it's ${label})`;
    case "cancel":
      return status === "draft" || status === "approved" || status === "sent" ? null : status === "partially_received" ? "Part of this order has arrived. Close it instead to stop waiting for the rest." : `A ${label} order can't be cancelled`;
    case "close":
      return status === "partially_received" ? null : "Only partially received orders can be closed short";
  }
}

export interface PoLineState {
  id: string;
  productId: string;
  name: string;
  qtyOrdered: number;
  qtyReceived: number;
  unitCostCents: number;
}

export interface ReceiveInput {
  lineId: string;
  qty: number;
  /** What the vendor charged per unit, if different from the order. */
  unitCostCents?: number | null;
}

export interface PlannedReceipt {
  lines: { lineId: string; productId: string; name: string; qty: number; unitCostCents: number; orderedCostCents: number }[];
  /** The order's status once this is received. */
  status: "partially_received" | "received";
}

/** A delivery against a purchase order: whole units, no more than is still due on each line. */
export function planReceipt(lines: PoLineState[], input: ReceiveInput[]): PlannedReceipt {
  const out: PlannedReceipt["lines"] = [];
  const got = new Map<string, number>();
  for (const r of input) {
    if (!r.qty) continue;
    const l = lines.find((x) => x.id === r.lineId);
    if (!l) throw new Error("That line isn't on this purchase order");
    if (!Number.isInteger(r.qty) || r.qty < 0) throw new Error(`Enter whole units received for ${l.name}`);
    const due = l.qtyOrdered - l.qtyReceived - (got.get(l.id) ?? 0);
    if (r.qty > due) throw new Error(`${l.name}: receiving ${r.qty}, but only ${due} ${due === 1 ? "is" : "are"} still due`);
    const cost = r.unitCostCents ?? l.unitCostCents;
    if (!Number.isInteger(cost) || cost < 0) throw new Error(`Enter a cost for ${l.name}`);
    got.set(l.id, (got.get(l.id) ?? 0) + r.qty);
    out.push({ lineId: l.id, productId: l.productId, name: l.name, qty: r.qty, unitCostCents: cost, orderedCostCents: l.unitCostCents });
  }
  if (!out.length) throw new Error("Enter what arrived");
  const complete = lines.every((l) => l.qtyReceived + (got.get(l.id) ?? 0) >= l.qtyOrdered);
  return { lines: out, status: complete ? "received" : "partially_received" };
}

/** Shelf cost after receiving: the average of what's there and what arrived. Negative stock carries no cost. */
export function weightedCostCents(onHand: number, currentCostCents: number, qty: number, unitCostCents: number): number {
  const have = Math.max(0, onHand);
  if (have + qty <= 0) return unitCostCents;
  return Math.round((have * currentCostCents + qty * unitCostCents) / (have + qty));
}

// ───────────────────────────── Counts ─────────────────────────────

export interface CountLine {
  productId: string;
  counted: number | null;
}

/**
 * Stock movements that make on-hand match a count. A cycle count only touches what was counted; a
 * full stocktake treats anything not counted as zero.
 */
export function countAdjustments(kind: "cycle" | "full", lines: CountLine[], onHand: Record<string, number>): { productId: string; counted: number; onHand: number; variance: number }[] {
  return lines
    .filter((l) => kind === "full" || l.counted !== null)
    .map((l) => {
      const counted = l.counted ?? 0;
      const have = onHand[l.productId] ?? 0;
      return { productId: l.productId, counted, onHand: have, variance: counted - have };
    });
}

// ───────────────────────────── Ledger labels ─────────────────────────────

export const LEDGER_KIND_LABEL: Record<string, string> = {
  opening: "Opening balance",
  sale: "Sale",
  refund: "Refund",
  void: "Void",
  receive: "Received",
  transfer_out: "Transfer out",
  transfer_in: "Transfer in",
  adjust: "Adjustment",
  stocktake: "Stocktake",
  upload: "Bulk upload",
};

export const ADJUST_REASONS = ["damage", "theft", "count_correction", "back_bar", "found", "other"] as const;
export type AdjustReasonKey = (typeof ADJUST_REASONS)[number];
export const ADJUST_REASON_LABEL: Record<AdjustReasonKey, string> = {
  damage: "Damaged",
  theft: "Theft",
  count_correction: "Count correction",
  back_bar: "Used in service / back bar",
  found: "Found",
  other: "Other",
};
/** Reasons that only take stock away; "found" only adds, count corrections and other go either way. */
export const ADJUST_DIRECTION: Record<AdjustReasonKey, "out" | "in" | "either"> = {
  damage: "out",
  theft: "out",
  back_bar: "out",
  found: "in",
  count_correction: "either",
  other: "either",
};
