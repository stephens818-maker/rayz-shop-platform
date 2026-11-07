/**
 * Which barbers a report covers: one barber, any set of barbers, a saved barber group, or all of
 * them. Limited to the barbers the viewer can see; people who may only see their own numbers always
 * get themselves.
 */
import { locationTokens } from "./locations";

export interface BarberRef {
  id: string;
  /** First name or the admin-set display label. Never the surname. */
  name: string;
  /** Shops they work at. */
  shopIds: string[];
  active?: boolean;
}

export interface BarberGroup {
  id: string;
  name: string;
  staffIds: string[];
}

export type BarberKind = "all" | "self" | "one" | "custom" | "group";

export interface BarberSelection {
  kind: BarberKind;
  /** Null means every barber, with no filter, so tickets without a barber count too. */
  staffIds: string[] | null;
  /** The canonical `staff` URL value: "group:<id>" or comma-separated ids. Null for all barbers or yourself. */
  param: string | null;
  group?: { id: string; name: string; /** Barbers in the group the viewer can't see. */ hidden: number };
}

export class BarberError extends Error {}

/** The segment for tickets with no barber on them (retail-only sales). */
export const NO_BARBER = "none";
export const NO_BARBER_LABEL = "No barber";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `staff` may repeat (`staff=a&staff=b`) or be comma-separated (`staff=a,b`). */
export const barberTokens = locationTokens;

export function resolveBarbers(raw: string | string[] | null | undefined, o: { visible: BarberRef[]; groups: BarberGroup[]; self: string | null }): BarberSelection {
  const tokens = barberTokens(raw);
  if (o.self) {
    if (tokens.every((t) => t === "all" || t === o.self)) return { kind: "self", staffIds: [o.self], param: null };
    throw new BarberError("You can only see your own numbers");
  }
  const visible = o.visible.map((b) => b.id);
  const ordered = (ids: Iterable<string>) => {
    const set = new Set(ids);
    return visible.filter((id) => set.has(id));
  };
  if (!tokens.length || (tokens.length === 1 && tokens[0] === "all")) return { kind: "all", staffIds: null, param: null };
  if (tokens.length === 1 && tokens[0].startsWith("group:")) {
    const g = o.groups.find((x) => x.id === tokens[0].slice(6));
    if (!g) throw new BarberError("That barber group doesn't exist");
    const staffIds = ordered(g.staffIds);
    if (!staffIds.length) throw new BarberError(`None of the barbers in ${g.name} work at your shops`);
    return { kind: "group", staffIds, param: `group:${g.id}`, group: { id: g.id, name: g.name, hidden: g.staffIds.filter((id) => !visible.includes(id)).length } };
  }
  if (tokens.some((t) => t === "all" || t.startsWith("group:"))) throw new BarberError("Pick barbers, a group, or all barbers, not a mix");
  for (const t of tokens) if (!UUID.test(t) || !visible.includes(t)) throw new BarberError("That barber isn't at your shops");
  const staffIds = ordered(tokens);
  return { kind: staffIds.length === 1 ? "one" : "custom", staffIds, param: staffIds.join(",") };
}

/** "All barbers", "Floaters: Jamie, Daisey", "Jamie, Kat", one name. */
export function barberLabel(sel: BarberSelection, names: (id: string) => string): string {
  if (!sel.staffIds) return "All barbers";
  const list = sel.staffIds.map(names);
  if (sel.kind === "group") return `${sel.group!.name}: ${list.join(", ")}`;
  return list.join(", ");
}
