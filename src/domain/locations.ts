/**
 * Which shops a report covers: one shop, any set of shops, a saved location group, or all of them.
 * Always limited to the shops the viewer has access to.
 */

export interface LocationGroup {
  id: string;
  name: string;
  shopIds: string[];
}

export type LocationKind = "current" | "all" | "one" | "custom" | "group";

export interface LocationSelection {
  kind: LocationKind;
  /** In the viewer's shop order. */
  shopIds: string[];
  /** The canonical URL value: "all", "group:<id>", or comma-separated shop ids. Null = current shop. */
  param: string | null;
  group?: { id: string; name: string; /** Shops in the group the viewer can't see. */ hidden: number };
}

export class LocationError extends Error {}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The `shop` parameter may repeat (`shop=a&shop=b`) or be comma-separated (`shop=a,b`). */
export function locationTokens(raw: string | string[] | null | undefined): string[] {
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return [...new Set(list.flatMap((x) => x.split(",")).map((x) => x.trim()).filter(Boolean))];
}

export function resolveLocations(
  raw: string | string[] | null | undefined,
  o: { accessShopIds: string[]; currentShopId: string | null; groups: LocationGroup[] },
): LocationSelection {
  const tokens = locationTokens(raw);
  const access = o.accessShopIds;
  const ordered = (ids: Iterable<string>) => {
    const set = new Set(ids);
    return access.filter((id) => set.has(id));
  };
  if (!tokens.length) {
    if (o.currentShopId && access.includes(o.currentShopId)) return { kind: "current", shopIds: [o.currentShopId], param: null };
    return { kind: "current", shopIds: [...access], param: null };
  }
  if (tokens.length === 1 && tokens[0] === "all") return { kind: "all", shopIds: [...access], param: "all" };
  if (tokens.length === 1 && tokens[0].startsWith("group:")) {
    const g = o.groups.find((x) => x.id === tokens[0].slice(6));
    if (!g) throw new LocationError("That location group doesn't exist");
    const shopIds = ordered(g.shopIds);
    if (!shopIds.length) throw new LocationError(`None of the shops in ${g.name} are in your access`);
    return { kind: "group", shopIds, param: `group:${g.id}`, group: { id: g.id, name: g.name, hidden: g.shopIds.filter((id) => !access.includes(id)).length } };
  }
  if (tokens.some((t) => t === "all" || t.startsWith("group:"))) throw new LocationError("Pick shops, a group, or all shops, not a mix");
  for (const t of tokens) if (!UUID.test(t) || !access.includes(t)) throw new LocationError("That shop is outside your access");
  const shopIds = ordered(tokens);
  return { kind: shopIds.length === 1 ? "one" : "custom", shopIds, param: shopIds.join(",") };
}

/** `shops` are the viewer's shops. */
export function locationLabel(sel: LocationSelection, shops: { id: string; name: string }[], brandWide: boolean): string {
  const names = sel.shopIds.map((id) => shops.find((s) => s.id === id)?.name ?? "");
  if (sel.kind === "group") return `${sel.group!.name}: ${names.join(", ")}`;
  if (names.length === 1) return names[0];
  if (names.length === shops.length) return brandWide ? "All shops" : "All my shops";
  return names.join(", ");
}
