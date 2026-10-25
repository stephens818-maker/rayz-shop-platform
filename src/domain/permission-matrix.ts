import { Overrides, Permission } from "./permissions";

/**
 * Squire's per-staff permission grid (area × action) laid over Rayz permissions. A cell is one or
 * more permissions; allowing or denying it sets a per-person override on each. "always" is
 * something every staff login can do, and a missing cell has no counterpart.
 */
export const MATRIX_ACTIONS = [
  { key: "view", label: "View" },
  { key: "edit", label: "Add/Edit" },
  { key: "book", label: "Book" },
  { key: "modify", label: "Modify" },
  { key: "history", label: "History" },
  { key: "cancel", label: "Cancel" },
  { key: "block", label: "Block time" },
] as const;
export type MatrixAction = (typeof MATRIX_ACTIONS)[number]["key"];
export type MatrixCell = readonly Permission[] | "always";

export interface MatrixArea {
  key: string;
  label: string;
  /** What each action means here, when it isn't obvious from the permission's own label. */
  cells?: Partial<Record<MatrixAction, MatrixCell>>;
  /** A single yes/no across the row, like Squire's Open Cash Drawer and Custom Charge. */
  single?: readonly Permission[];
}

export const MATRIX_AREAS: MatrixArea[] = [
  {
    key: "appointments",
    label: "Appointments",
    cells: {
      view: "always",
      edit: ["calendar.manage"],
      book: ["calendar.manage"],
      modify: ["calendar.squeeze_in"],
      history: ["sales.view"],
      cancel: ["calendar.manage"],
      block: ["blocks.own"],
    },
  },
  { key: "contact", label: "Contact info", cells: { view: ["clients.reveal"], edit: ["clients.edit"] } },
  { key: "clients", label: "Clients", cells: { view: ["clients.view_all"], edit: ["clients.edit"], modify: ["clients.merge"], history: ["notes.view"] } },
  { key: "services", label: "Services", cells: { view: "always", edit: ["catalog.prices"], modify: ["catalog.manage"] } },
  { key: "schedules", label: "Schedules", cells: { view: "always", edit: ["schedules.edit"], modify: ["timeoff.approve"], block: ["blocks.others"] } },
  { key: "bank", label: "Bank accounts", cells: { view: ["payments.accounts"], edit: ["payments.banking"] } },
  { key: "profile", label: "Profile", cells: { view: ["staff.contact"], edit: ["staff.manage"] } },
  { key: "reports", label: "Reports", cells: { view: ["reports.all_staff"], edit: ["report_builder.build"], history: ["report.audit_log.view"] } },
  { key: "products", label: "Products", cells: { view: "always", edit: ["catalog.manage"], modify: ["inventory.manage"] } },
  {
    key: "inventory",
    label: "Inventory",
    cells: { view: ["report.inventory.view"], edit: ["inventory.adjust"], modify: ["inventory.transfer"], history: ["report.inventory_movement.view"] },
  },
  { key: "campaigns", label: "Campaigns", cells: { view: ["campaign_center.view"], edit: ["campaign_center.create"], modify: ["campaign_center.send"] } },
  {
    key: "register",
    label: "Register",
    cells: {
      view: ["sales.view"],
      edit: ["checkout.any"],
      modify: ["pos.discount", "pos.price_override"],
      history: ["report.cash_drawer.view"],
      cancel: ["sales.refund"],
    },
  },
  { key: "drawer", label: "Open cash drawer", single: ["drawer.no_sale"] },
  { key: "custom_charge", label: "Custom charge", single: ["pos.custom_charge"] },
];

export type CellState = "always" | "on" | "off" | "partial";
export type CellOverride = boolean | null | "mixed";

export function cellState(has: ReadonlySet<Permission>, cell: MatrixCell): CellState {
  if (cell === "always") return "always";
  const n = cell.filter((p) => has.has(p)).length;
  return n === cell.length ? "on" : n === 0 ? "off" : "partial";
}

export function cellOverride(o: Overrides, cell: readonly Permission[]): CellOverride {
  const vs = new Set(cell.map((p) => o[p] ?? null));
  return vs.size === 1 ? [...vs][0] : "mixed";
}

/** Allow (true), deny (false) or back to the role (null) for every permission in the cell. */
export function setCell(o: Overrides, cell: readonly Permission[], v: boolean | null): Overrides {
  const out: Overrides = { ...o };
  for (const p of cell) {
    if (v === null) delete out[p];
    else out[p] = v;
  }
  return out;
}

/** Role default → Allow → Deny → Role default. */
export const nextOverride = (cur: CellOverride): boolean | null => (cur === null || cur === "mixed" ? true : cur ? false : null);

/** Every permission the grid touches, for "the rest are in the list below". */
export const MATRIX_PERMISSIONS: ReadonlySet<Permission> = new Set(MATRIX_AREAS.flatMap((a) => [...(a.single ?? []), ...Object.values(a.cells ?? {}).flatMap((c) => (c === "always" ? [] : [...c]))]));
