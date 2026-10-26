"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { syncedText, useBrandSync } from "@/components/brand-sync";
import { Badge, Button, Card, CardHeader, Field, Input, Notice, Select, Textarea, cx } from "@/components/ui";
import {
  BRAND_ADMIN_ALWAYS,
  BRAND_ADMIN_ROLE_KEY,
  BRAND_LEVEL_ONLY,
  BRAND_ONLY,
  FEATURE_PERMISSIONS,
  OWNER_GRANTS,
  OWNER_ONLY,
  GRANT_ONLY,
  PERMISSION_GROUPS,
  Permission,
  REPORTS,
  SCOPE_LABEL,
  SHOP_SCOPES,
  ShopScope,
  isBrandLevelRole,
  reportExport,
  reportView,
} from "@/domain/permissions";
import { deleteRoleAction, resetRoleAction, saveRoleAction } from "../../actions";

type RoleForm = { id: string; key: string | null; name: string; description: string; permissions: string[]; maxDiscountPct: number; defaultScope: ShopScope; brandLevel: boolean };
type Starter = { name: string; permissions: string[]; maxDiscountPct: number; defaultScope: ShopScope };

export function RoleEditor({
  initial,
  template,
  starters,
  mine,
  isOwner = false,
  myMaxDiscount,
  people,
  readOnly,
}: {
  initial: RoleForm | null;
  template: { permissions: string[]; maxDiscountPct: number } | null;
  starters: Starter[];
  mine: string[];
  isOwner?: boolean;
  myMaxDiscount: number;
  people: number;
  readOnly: string | null;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [scope, setScope] = useState<ShopScope>(initial?.defaultScope ?? "one");
  const [maxPct, setMaxPct] = useState(initial?.maxDiscountPct ?? 0);
  const [brandLevel, setBrandLevel] = useState(initial?.brandLevel ?? false);
  const custom = !initial?.key;
  const roleIsBrandLevel = isBrandLevelRole({ key: initial?.key ?? null, brandLevel });
  const [perms, setPerms] = useState<Set<string>>(new Set([...(initial?.permissions ?? []), ...(initial?.key === BRAND_ADMIN_ROLE_KEY ? BRAND_ADMIN_ALWAYS : [])]));
  const has = useMemo(() => new Set(mine), [mine]);
  const original = useMemo(() => new Set(initial?.permissions ?? []), [initial]);
  const fromTemplate = useMemo(() => (template ? new Set(template.permissions) : null), [template]);
  const locked = !!readOnly;

  const changed = [...new Set([...perms, ...original])].filter((p) => perms.has(p) !== original.has(p));
  const dirty = changed.length > 0 || brandLevel !== (initial?.brandLevel ?? false) || name !== (initial?.name ?? "") || description !== (initial?.description ?? "") || scope !== (initial?.defaultScope ?? "one") || maxPct !== (initial?.maxDiscountPct ?? 0);

  /** Why this toggle can't be flipped by the person editing, if it can't. */
  const brandAdmin = initial?.key === BRAND_ADMIN_ROLE_KEY;
  const blocked = (p: Permission) =>
    locked
      ? readOnly
      : brandAdmin && BRAND_ADMIN_ALWAYS.has(p)
        ? "Brand Admins always have this"
        : OWNER_ONLY.has(p)
          ? "Brand Owner only"
          : BRAND_LEVEL_ONLY.has(p) && !roleIsBrandLevel
            ? "Brand-level roles only"
            : OWNER_GRANTS.has(p) && !isOwner
            ? "Only the Brand Owner grants this"
            : !has.has(p)
              ? "You don't have this yourself"
              : null;

  const toggle = (p: Permission, on: boolean) => {
    const next = new Set(perms);
    if (on) next.add(p);
    else {
      next.delete(p);
      const m = p.match(/^report\.(.+)\.view$/);
      if (m) next.delete(`report.${m[1]}.export`);
    }
    setPerms(next);
  };
  const setReports = (view: boolean, exp: boolean) => {
    const next = new Set(perms);
    for (const r of REPORTS) {
      for (const [p, on] of [
        [reportView(r.key), view],
        [reportExport(r.key), exp],
      ] as const) {
        if (blocked(p)) continue;
        if (on) next.add(p);
        else next.delete(p);
      }
    }
    setPerms(next);
  };

  const run = (fn: () => Promise<{ ok: true; data: { id: string } } | { ok: false; error: string }>, msg: string, go?: (id: string) => string) =>
    start(async () => {
      setError(null);
      setSaved(null);
      const r = await fn();
      if (!r.ok) return setError(r.error);
      setSaved(msg);
      if (go) router.push(go(r.data.id));
      else router.refresh();
    });

  const sync = useBrandSync();
  const shopRole = !!initial && !isBrandLevelRole({ key: initial.key, brandLevel: initial.brandLevel }) && !brandLevel && initial.defaultScope !== "all" && scope !== "all";
  const save = () => {
    if (shopRole) {
      setError(null);
      setSaved(null);
      return void sync.open({
        label: `${name} role`,
        changes: [{ type: "role", item: initial!.id, value: { name, description, permissions: [...perms], maxDiscountPct: maxPct, defaultScope: scope } }],
        onDone: (r) => setSaved(r.status === "scheduled" ? syncedText(r) : r.shops ? `Saved. ${syncedText(r)}.` : "Saved to the brand. Shops keep the role as it was until it's pushed."),
      });
    }
    run(
      () => saveRoleAction({ id: initial?.id ?? null, name, description, permissions: [...perms], maxDiscountPct: maxPct, defaultScope: scope, ...(custom ? { brandLevel } : {}) }),
      initial ? "Saved. Everyone with this role has the change now." : "Role created",
      initial ? undefined : (id) => `/admin/permissions/roles/${id}`,
    );
  };

  const tag = (p: Permission) => {
    if (fromTemplate && fromTemplate.has(p) !== perms.has(p)) return <Badge tone="amber">{perms.has(p) ? "added" : "removed"} vs template</Badge>;
    return null;
  };

  return (
    <div className="space-y-4 pb-24">
      {readOnly && <Notice tone="blue">{readOnly}</Notice>}
      {!initial && starters.length > 0 && !locked && (
        <Card className="p-4">
          <div className="mb-2 text-sm font-medium">Start from</div>
          <div className="flex flex-wrap gap-2">
            {starters.map((s) => (
              <Button
                key={s.name}
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => {
                  setPerms(new Set(s.permissions.filter((p) => !blocked(p as Permission))));
                  setMaxPct(Math.min(s.maxDiscountPct, myMaxDiscount));
                  setScope(s.defaultScope);
                }}
              >
                {s.name}
              </Button>
            ))}
            <Button type="button" variant="secondary" size="sm" onClick={() => setPerms(new Set())}>
              Nothing
            </Button>
          </div>
        </Card>
      )}

      <Card>
        <CardHeader title="Role" />
        <fieldset disabled={locked} className="grid gap-4 p-4 sm:grid-cols-2">
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Lead Barber" />
          </Field>
          <Field label="Default shop access" hint="Used when someone is first given this role. Change it per person.">
            <Select value={scope} onChange={(e) => setScope(e.target.value as ShopScope)}>
              {SHOP_SCOPES.map((s) => (
                <option key={s} value={s}>
                  {SCOPE_LABEL[s]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Description" className="sm:col-span-2">
            <Textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
          {custom && (
            <label className="flex items-start gap-3 text-sm sm:col-span-2">
              <input
                type="checkbox"
                className="mt-1 h-4 w-4 accent-ink-900"
                checked={brandLevel}
                disabled={!isOwner}
                data-testid="brand-level"
                onChange={(e) => {
                  setBrandLevel(e.target.checked);
                  if (!e.target.checked) setPerms(new Set([...perms].filter((p) => !BRAND_LEVEL_ONLY.has(p as Permission))));
                }}
              />
              <span>
                <span className="font-medium">Brand-level role</span>
                <span className="block text-xs text-zinc-500">
                  People in it with access to all shops may be given full client phone, email and address and client list exports by its rules. Shop and staff roles and
                  shop logins only get them as contact access, given to a person or a location. {isOwner ? "" : "Only the Brand Owner can change this."}
                </span>
              </span>
            </label>
          )}
        </fieldset>
      </Card>

      {PERMISSION_GROUPS.map((g) => (
        <Card key={g}>
          <CardHeader title={g} />
          <ul className="divide-y divide-zinc-100">
            {FEATURE_PERMISSIONS.filter((p) => p.group === g && !GRANT_ONLY.has(p.key)).map((p) => {
              const why = blocked(p.key);
              return (
                <li key={p.key} className={cx("flex items-start gap-3 px-4 py-2.5", why && "bg-zinc-50/60")}>
                  <input
                    id={p.key}
                    type="checkbox"
                    className="mt-1 h-4 w-4 accent-ink-900"
                    checked={perms.has(p.key)}
                    disabled={!!why}
                    onChange={(e) => toggle(p.key, e.target.checked)}
                  />
                  <label htmlFor={p.key} className="flex-1 text-sm">
                    <span className="font-medium">{p.label}</span>
                    {BRAND_ONLY.has(p.key) && (
                      <span className="ml-2 rounded bg-zinc-100 px-1.5 py-0.5 text-[11px] font-medium text-zinc-600">{BRAND_LEVEL_ONLY.has(p.key) ? "Brand-level only" : "All shops only"}</span>
                    )}
                    {"hint" in p && p.hint && <span className="block text-xs text-zinc-500">{p.hint}</span>}
                    {p.key === "pos.discount" && perms.has("pos.discount") && (
                      <span className="mt-1.5 flex items-center gap-2 text-xs text-zinc-600">
                        Up to
                        <Input
                          type="number"
                          min={0}
                          max={100}
                          className="h-7 w-20"
                          value={maxPct}
                          disabled={locked}
                          onChange={(e) => setMaxPct(Math.max(0, Math.min(100, Math.round(Number(e.target.value) || 0))))}
                        />
                        % off a ticket
                        {maxPct > myMaxDiscount && <span className="text-red-600">above your own limit ({myMaxDiscount}%)</span>}
                      </span>
                    )}
                  </label>
                  <span className="flex shrink-0 items-center gap-1.5 text-xs text-zinc-400">
                    {tag(p.key)}
                    {why && !locked && <span>{why}</span>}
                  </span>
                </li>
              );
            })}
          </ul>
        </Card>
      ))}

      <Card>
        <CardHeader
          title="Reports"
          subtitle="Each report is its own permission, and CSV export is granted separately. People only see these for the shops they have access to."
          action={
            !locked && (
              <span className="flex gap-2 text-xs">
                <button type="button" className="underline" onClick={() => setReports(true, true)}>
                  All with export
                </button>
                <button type="button" className="underline" onClick={() => setReports(true, false)}>
                  All, view only
                </button>
                <button type="button" className="underline" onClick={() => setReports(false, false)}>
                  None
                </button>
              </span>
            )
          }
        />
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-100 text-left text-xs uppercase tracking-wide text-zinc-500">
              <th className="px-4 py-2 font-medium">Report</th>
              <th className="w-24 px-2 py-2 text-center font-medium">View</th>
              <th className="w-28 px-2 py-2 text-center font-medium">Export CSV</th>
              <th className="w-40 px-2 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            {REPORTS.map((r) => {
              const v = reportView(r.key);
              const x = reportExport(r.key);
              return (
                <tr key={r.key}>
                  <td className="px-4 py-2">
                    <div className="font-medium">{r.label}</div>
                    {"hint" in r && r.hint && <div className="text-xs text-zinc-500">{r.hint}</div>}
                  </td>
                  <td className="text-center">
                    <input type="checkbox" aria-label={`${r.label}: view`} className="h-4 w-4 accent-ink-900" checked={perms.has(v)} disabled={!!blocked(v)} onChange={(e) => toggle(v, e.target.checked)} />
                  </td>
                  <td className="text-center">
                    <input
                      type="checkbox"
                      aria-label={`${r.label}: export`}
                      className="h-4 w-4 accent-ink-900"
                      checked={perms.has(x)}
                      disabled={!!blocked(x) || !perms.has(v)}
                      onChange={(e) => toggle(x, e.target.checked)}
                    />
                  </td>
                  <td className="px-2 text-right text-xs text-zinc-400">
                    {tag(v) ?? tag(x)}
                    {!locked && (blocked(v) || blocked(x)) && <span>{blocked(v) ?? blocked(x)}</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>

      {!locked && (
        <div className="fixed inset-x-0 bottom-0 z-20 border-t border-zinc-200 bg-white/95 backdrop-blur lg:left-60">
          <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-3 px-4 py-3">
            <div className="text-sm">
              {(error ?? sync.error) ? (
                <span className="text-red-600">{error ?? sync.error}</span>
              ) : saved && !dirty ? (
                <span className="text-green-700">{saved}</span>
              ) : (
                <span className="text-zinc-500">
                  {perms.size} permissions{changed.length ? ` · ${changed.length} changed` : ""}
                  {initial && people ? ` · applies to ${people} ${people === 1 ? "person" : "people"}` : ""}
                </span>
              )}
            </div>
            <div className="ml-auto flex gap-2">
              {initial?.key && (
                <Button type="button" variant="secondary" disabled={pending} onClick={() => confirm("Put this role back to its built-in template?") && run(() => resetRoleAction(initial.id), "Reset to template")}>
                  Reset to template
                </Button>
              )}
              {initial && !initial.key && (
                <Button
                  type="button"
                  variant="secondary"
                  disabled={pending}
                  onClick={() => confirm(`Delete the ${initial.name} role?`) && run(() => deleteRoleAction(initial.id), "Deleted", () => "/admin/permissions")}
                >
                  Delete role
                </Button>
              )}
              <Button type="button" variant="dark" disabled={pending || sync.pending || (!dirty && !!initial)} onClick={save}>
                {pending ? "Saving…" : initial ? "Save role" : "Create role"}
              </Button>
            </div>
          </div>
        </div>
      )}
      {sync.dialog}
    </div>
  );
}
