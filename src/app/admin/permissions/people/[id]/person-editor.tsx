"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { Badge, Button, Card, CardHeader, Input, Notice, Select, cx } from "@/components/ui";
import {
  BRAND_LEVEL_ONLY,
  BRAND_ONLY,
  FEATURE_PERMISSIONS,
  GRANT_ONLY,
  OWNER_GRANTS,
  OWNER_ONLY,
  OWNER_ROLE_KEY,
  Overrides,
  PERMISSION_GROUPS,
  Permission,
  REPORTS,
  RoleDef,
  SCOPE_LABEL,
  SHOP_SCOPES,
  ShopScope,
  accessByShop,
  diffPermissions,
  effectiveAccess,
  isBrandLevelPerson,
  permissionLabel,
  reportExport,
  reportView,
} from "@/domain/permissions";
import { saveUserAccessAction } from "../../actions";

type RoleOption = RoleDef & { id: string; defaultScope: ShopScope };
type State = {
  roleId: string;
  overrides: Overrides;
  maxDiscountPct: number | null;
  scope: ShopScope;
  scopeEntityId: string | null;
  scopeRegionId: string | null;
  shopIds: string[];
  shopRoles: Record<string, string>;
};
type ShopOption = { id: string; name: string; ownerEntityId: string | null; regionId: string | null };

/** The shops a scope covers: chosen ones, or every shop of the owner group or region. */
function scopeShopIds(s: State, shops: ShopOption[]) {
  if (s.scope === "entity") return shops.filter((x) => x.ownerEntityId === s.scopeEntityId).map((x) => x.id);
  if (s.scope === "region") return shops.filter((x) => x.regionId === s.scopeRegionId).map((x) => x.id);
  return s.shopIds;
}
const multiShop = (sc: ShopScope) => sc === "selected" || sc === "entity" || sc === "region";

/** Everything they could do at one of their shops, under each shop's role. */
function accessOf(roles: RoleOption[], s: State, all: ShopOption[]) {
  const main = roles.find((r) => r.id === s.roleId)!;
  const owner = main.key === OWNER_ROLE_KEY;
  const shops = multiShop(s.scope) ? scopeShopIds(s, all).map((shopId) => ({ shopId, role: roles.find((r) => r.id === s.shopRoles[shopId]) ?? null })) : [];
  return accessByShop(main, shops, owner ? {} : s.overrides, owner ? null : s.maxDiscountPct, owner ? "all" : s.scope);
}

const GROUPS: { title: string; perms: Permission[] }[] = [
  ...PERMISSION_GROUPS.map((g) => ({ title: g, perms: FEATURE_PERMISSIONS.filter((p) => p.group === g && !OWNER_ONLY.has(p.key) && !GRANT_ONLY.has(p.key)).map((p) => p.key as Permission) })),
  { title: "Reports", perms: REPORTS.flatMap((r) => [reportView(r.key), reportExport(r.key)]) },
];

export function PersonAccessEditor({
  staffId,
  initial,
  roles,
  shops,
  entities = [],
  regions = [],
  worksAt,
  mine,
  myMaxDiscount,
  iAmOwner,
  iAmBrandWide,
  readOnly,
  kind = "person",
}: {
  staffId: string;
  initial: State;
  roles: RoleOption[];
  shops: ShopOption[];
  /** Owner groups and regions the editor may scope people to. */
  entities?: { id: string; name: string }[];
  regions?: { id: string; name: string }[];
  worksAt: string[];
  mine: string[];
  myMaxDiscount: number;
  iAmOwner: boolean;
  iAmBrandWide: boolean;
  readOnly: string | null;
  kind?: "person" | "shop";
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [s, setS] = useState<State>(initial);
  const [onlyOverrides, setOnlyOverrides] = useState(false);
  const set = (patch: Partial<State>) => {
    setSaved(false);
    setS({ ...s, ...patch });
  };
  const has = useMemo(() => new Set(mine), [mine]);
  const role = roles.find((r) => r.id === s.roleId)!;
  const isOwnerRole = role.key === OWNER_ROLE_KEY;
  const before = useMemo(() => accessOf(roles, initial, shops).union, [roles, initial, shops]);
  const fromRole = effectiveAccess(role);
  const { union: after, uniform } = accessOf(roles, s, shops);
  const shopRoleOptions = roles.filter((r) => r.key !== OWNER_ROLE_KEY);
  const covered = scopeShopIds(s, shops);
  const hierarchy = s.scope === "entity" || s.scope === "region";
  const perShop = multiShop(s.scope) && !isOwnerRole && covered.length > 1;
  const scopes = SHOP_SCOPES.filter((sc) => (sc !== "entity" || entities.length || s.scope === sc) && (sc !== "region" || regions.length || s.scope === sc));
  const diff = diffPermissions(before.permissions, after.permissions);
  const locked = !!readOnly;
  const brandLevel = isBrandLevelPerson({ kind, scope: isOwnerRole ? "all" : s.scope, role });

  const setOverride = (p: Permission, v: boolean | null) => {
    const o: Overrides = { ...s.overrides };
    if (v === null) delete o[p];
    else o[p] = v;
    set({ overrides: o });
  };
  const toggleShop = (id: string) => {
    if (s.scope === "one") return set({ shopIds: [id] });
    if (!s.shopIds.includes(id)) return set({ shopIds: [...s.shopIds, id] });
    const { [id]: _, ...shopRoles } = s.shopRoles;
    set({ shopIds: s.shopIds.filter((x) => x !== id), shopRoles });
  };

  const save = () =>
    start(async () => {
      setError(null);
      const overrides = Object.fromEntries(Object.entries(s.overrides).filter(([p, v]) => brandLevel || !v || !BRAND_LEVEL_ONLY.has(p as Permission)));
      const r = await saveUserAccessAction({ staffId, ...s, shopIds: covered, overrides: overrides as Record<string, boolean> });
      if (!r.ok) return setError(r.error);
      setSaved(true);
      router.refresh();
    });

  return (
    <div className="space-y-4 pb-24">
      {readOnly && <Notice tone="blue">{readOnly}</Notice>}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Role" subtitle="The starting set of permissions. Overrides below adjust it for this person only." />
          <div className="space-y-2 p-4">
            <Select value={s.roleId} disabled={locked} onChange={(e) => set({ roleId: e.target.value })} aria-label="Role">
              {roles.map((r) => (
                <option key={r.id} value={r.id} disabled={r.key === OWNER_ROLE_KEY && !iAmOwner && r.id !== initial.roleId}>
                  {r.name}
                  {!r.key ? " (custom)" : ""}
                  {r.key === OWNER_ROLE_KEY && !iAmOwner ? " (Brand Owner only)" : ""}
                </option>
              ))}
            </Select>
            <p className="text-xs text-zinc-500">
              {isOwnerRole
                ? "Brand Owner always has every permission at every shop."
                : `${fromRole.permissions.size} permissions from the role${fromRole.permissions.has("pos.discount") ? `, discounts up to ${fromRole.maxDiscountPct}%` : ""}.`}
            </p>
          </div>
        </Card>
        <Card>
          <CardHeader
            title="Assigned shops"
            subtitle={`The only shops they see. ${worksAt.length ? `Works at ${worksAt.join(", ")}` : "Not on any shop's team yet"}`}
          />
          <fieldset disabled={locked || isOwnerRole} className="space-y-3 p-4">
            <div className="flex flex-wrap gap-1.5">
              {scopes.map((sc) => (
                <button
                  key={sc}
                  type="button"
                  disabled={sc === "all" && !iAmBrandWide}
                  onClick={() =>
                    set({
                      scope: sc,
                      shopIds: sc === "one" ? s.shopIds.slice(0, 1) : s.shopIds,
                      scopeEntityId: sc === "entity" ? (s.scopeEntityId ?? entities[0]?.id ?? null) : null,
                      scopeRegionId: sc === "region" ? (s.scopeRegionId ?? regions[0]?.id ?? null) : null,
                    })
                  }
                  className={cx(
                    "rounded-full px-3 py-1 text-sm ring-1 disabled:opacity-40",
                    (isOwnerRole ? "all" : s.scope) === sc ? "bg-ink-900 text-white ring-ink-900" : "bg-white ring-zinc-300 hover:bg-zinc-50",
                  )}
                >
                  {SCOPE_LABEL[sc]}
                </button>
              ))}
            </div>
            {hierarchy && !isOwnerRole && (
              <div className="space-y-1">
                <Select
                  aria-label={s.scope === "entity" ? "Owner group" : "Region"}
                  value={(s.scope === "entity" ? s.scopeEntityId : s.scopeRegionId) ?? ""}
                  onChange={(e) => set(s.scope === "entity" ? { scopeEntityId: e.target.value || null } : { scopeRegionId: e.target.value || null })}
                >
                  {(s.scope === "entity" ? entities : regions).map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name}
                    </option>
                  ))}
                </Select>
                <p className="text-xs text-zinc-500">
                  Every location of this {s.scope === "entity" ? "owner group" : "region"}, including locations added to it later.{" "}
                  {covered.length ? `Now: ${covered.length} location${covered.length === 1 ? "" : "s"}.` : "It has no locations yet."}
                </p>
              </div>
            )}
            {s.scope !== "all" && !isOwnerRole && (
              <div className={cx("grid gap-1.5", !perShop && "sm:grid-cols-2")}>
                {(hierarchy ? shops.filter((x) => covered.includes(x.id)) : shops).map((shop) => (
                  <div key={shop.id} className="flex min-h-8 items-center justify-between gap-2 text-sm">
                    <label className="flex min-w-0 items-center gap-2">
                      <input
                        type={s.scope === "one" ? "radio" : "checkbox"}
                        name="shop"
                        className="h-4 w-4 accent-ink-900"
                        checked={covered.includes(shop.id)}
                        disabled={hierarchy}
                        onChange={() => toggleShop(shop.id)}
                      />
                      {shop.name}
                    </label>
                    {perShop && covered.includes(shop.id) && (
                      <Select
                        aria-label={`Role at ${shop.name}`}
                        className="h-8 w-48 py-1 text-xs"
                        value={s.shopRoles[shop.id] ?? s.roleId}
                        onChange={(e) => {
                          const { [shop.id]: _, ...rest } = s.shopRoles;
                          set({ shopRoles: e.target.value === s.roleId ? rest : { ...rest, [shop.id]: e.target.value } });
                        }}
                      >
                        {shopRoleOptions.map((r) => (
                          <option key={r.id} value={r.id}>
                            {r.id === s.roleId ? `${r.name} (main role)` : r.name}
                          </option>
                        ))}
                      </Select>
                    )}
                  </div>
                ))}
              </div>
            )}
            {multiShop(s.scope) && !isOwnerRole && !uniform && (
              <p className="text-xs text-zinc-500">A different role at some shops: they work in one shop at a time, with that shop&apos;s role, and switch between only these shops.</p>
            )}
            {(s.scope === "all" || isOwnerRole) && <p className="text-xs text-zinc-500">Every shop, including shops added later, and brand-level records.</p>}
          </fieldset>
        </Card>
      </div>

      {!isOwnerRole && (
        <Card>
          <CardHeader
            title="Permissions for this person"
            subtitle={
              uniform
                ? "Leave a permission on the role default, or allow or deny it for this person only."
                : "Overrides apply at every shop. With a different role at some shops, “on” means on at one or more of them; each shop's role decides there."
            }
            action={
              <label className="flex items-center gap-1.5 text-xs text-zinc-600">
                <input type="checkbox" checked={onlyOverrides} onChange={(e) => setOnlyOverrides(e.target.checked)} />
                Only show overrides
              </label>
            }
          />
          {after.permissions.has("pos.discount") && (
            <div className="flex flex-wrap items-center gap-2 border-b border-zinc-100 px-4 py-3 text-sm">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  disabled={locked}
                  checked={s.maxDiscountPct !== null}
                  onChange={(e) => set({ maxDiscountPct: e.target.checked ? Math.min(role.maxDiscountPct, myMaxDiscount) : null })}
                />
                Personal discount limit
              </label>
              {s.maxDiscountPct !== null ? (
                <>
                  <Input
                    type="number"
                    min={0}
                    max={100}
                    disabled={locked}
                    className="h-8 w-20"
                    value={s.maxDiscountPct}
                    onChange={(e) => set({ maxDiscountPct: Math.max(0, Math.min(100, Math.round(Number(e.target.value) || 0))) })}
                  />
                  <span className="text-zinc-500">% (role: {role.maxDiscountPct}%)</span>
                </>
              ) : (
                <span className="text-zinc-500">Uses the role&apos;s {role.maxDiscountPct}%</span>
              )}
            </div>
          )}
          {GROUPS.map((g) => {
            const rows = g.perms.filter((p) => !onlyOverrides || p in s.overrides);
            if (!rows.length) return null;
            return (
              <div key={g.title}>
                <div className="bg-zinc-50 px-4 py-1.5 text-xs font-semibold uppercase tracking-wide text-zinc-500">{g.title}</div>
                <ul className="divide-y divide-zinc-100">
                  {rows.map((p) => {
                    const o = s.overrides[p];
                    const lack = !has.has(p) || (OWNER_GRANTS.has(p) && !iAmOwner);
                    const shopLevel = BRAND_LEVEL_ONLY.has(p) && !brandLevel;
                    const exportWithoutView = p.endsWith(".export") && !after.permissions.has(p.replace(/\.export$/, ".view") as Permission);
                    return (
                      <li key={p} className="flex flex-wrap items-center gap-3 px-4 py-2 text-sm">
                        <span className="min-w-0 flex-1">
                          {permissionLabel(p)}
                          {BRAND_ONLY.has(p) && (
                            <span className="ml-2 rounded bg-zinc-100 px-1.5 py-0.5 text-[11px] font-medium text-zinc-600">
                              {BRAND_LEVEL_ONLY.has(p)
                                ? brandLevel
                                  ? "Brand-level only"
                                  : "Brand-level only: never for shop logins or shop and staff roles"
                                : s.scope === "all"
                                  ? "All shops only"
                                  : "All shops only: off with this shop access"}
                            </span>
                          )}
                          {lack && <span className="ml-2 text-xs text-zinc-400">you don&apos;t have this</span>}
                        </span>
                        <span className="w-16 text-xs text-zinc-500">{fromRole.permissions.has(p) ? "role: yes" : "role: no"}</span>
                        <span className="inline-flex overflow-hidden rounded-lg text-xs ring-1 ring-zinc-300" role="radiogroup" aria-label={permissionLabel(p)}>
                          {(
                            [
                              [null, "Role default"],
                              [true, "Allow"],
                              [false, "Deny"],
                            ] as const
                          ).map(([v, l]) => (
                            <button
                              key={l}
                              type="button"
                              role="radio"
                              aria-checked={(o ?? null) === v}
                              disabled={locked || (lack && v !== (o ?? null)) || (shopLevel && v === true)}
                              onClick={() => setOverride(p, v)}
                              className={cx(
                                "px-2.5 py-1 disabled:opacity-40",
                                (o ?? null) === v ? (v === true ? "bg-emerald-600 text-white" : v === false ? "bg-red-600 text-white" : "bg-ink-900 text-white") : "bg-white hover:bg-zinc-50",
                              )}
                            >
                              {l}
                            </button>
                          ))}
                        </span>
                        <span className="w-14 text-right">
                          {after.permissions.has(p) ? <Badge tone="green">on</Badge> : <Badge>{exportWithoutView && o === true ? "needs view" : "off"}</Badge>}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </Card>
      )}

      {!locked && (
        <div className="fixed inset-x-0 bottom-0 z-20 border-t border-zinc-200 bg-white/95 backdrop-blur lg:left-60">
          <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-3 px-4 py-3 text-sm">
            {error ? (
              <span className="text-red-600">{error}</span>
            ) : saved ? (
              <span className="text-green-700">Saved. Applies on their next click.</span>
            ) : (
              <span className="text-zinc-500">
                {after.permissions.size} permissions
                {diff.added.length ? ` · +${diff.added.length}` : ""}
                {diff.removed.length ? ` · −${diff.removed.length}` : ""}
                {after.maxDiscountPct !== before.maxDiscountPct ? ` · discount limit ${before.maxDiscountPct}% → ${after.maxDiscountPct}%` : ""}
              </span>
            )}
            <Button type="button" variant="dark" className="ml-auto" disabled={pending} onClick={save}>
              {pending ? "Saving…" : "Save access"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
