"use client";

import Link from "next/link";
import { Fragment, useMemo, useState } from "react";
import { syncedText, useBrandSync } from "@/components/brand-sync";
import { Button, Card, Input, Notice, Select, cx } from "@/components/ui";
import { AREAS, AREA_ROWS, AreaRow, REACH_LABEL, heldReach, levelIndex, permissionTag, rowMatches, rowPermissions, withLevel } from "@/domain/permission-areas";
import {
  BRAND_ADMIN_ALWAYS,
  BRAND_ADMIN_ROLE_KEY,
  BRAND_LEVEL_ONLY,
  GRANT_ONLY,
  MoneyLimits,
  OWNER_GRANTS,
  OWNER_ONLY,
  Permission,
  ShopScope,
  permissionLabel,
} from "@/domain/permissions";

type MatrixRole = {
  id: string;
  key: string | null;
  name: string;
  description: string;
  permissions: string[];
  maxDiscountPct: number;
  defaultScope: ShopScope;
  moneyLimits: Partial<MoneyLimits>;
  brandLevel: boolean;
  isBrandLevel: boolean;
  isOwnerRole: boolean;
  people: number;
};

const same = (a: ReadonlySet<string>, b: ReadonlySet<string>) => a.size === b.size && [...a].every((p) => b.has(p));

/**
 * Roles × permissions, a row per area setting with a level in each cell. Changes stay on the page
 * until saved; saving sends every changed role through the brand change scope together.
 */
export function RoleMatrix({ roles, mine, isOwner, readOnly }: { roles: MatrixRole[]; mine: string[]; isOwner: boolean; readOnly: string | null }) {
  const has = useMemo(() => new Set(mine), [mine]);
  const [saved, setSaved] = useState(() => new Map(roles.map((r) => [r.id, new Set(r.permissions as Permission[])])));
  const [perms, setPerms] = useState(saved);
  const [q, setQ] = useState("");
  const [area, setArea] = useState("");
  const [onlyDiffer, setOnlyDiffer] = useState(false);
  const [onlyChanged, setOnlyChanged] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const sync = useBrandSync();
  const locked = !!readOnly;

  /** Why this role can't have this permission turned on or off by the person editing. */
  const blocked = (r: MatrixRole, p: Permission, on: boolean): string | null => {
    if (OWNER_ONLY.has(p)) return "Brand Owner only";
    if (GRANT_ONLY.has(p)) return "Only with a contact access grant";
    if (on && BRAND_LEVEL_ONLY.has(p) && !r.isBrandLevel) return "Brand-level roles only";
    if (!on && r.key === BRAND_ADMIN_ROLE_KEY && BRAND_ADMIN_ALWAYS.has(p)) return "Brand Admins always have this";
    if (OWNER_GRANTS.has(p) && !isOwner) return "Only the Brand Owner grants this";
    if (!has.has(p)) return "You don't have this yourself";
    return null;
  };
  const levelWhy = (r: MatrixRole, row: AreaRow, i: number): string | null => {
    const cur = perms.get(r.id)!;
    const next = withLevel(row, cur, i);
    for (const p of rowPermissions(row)) if (cur.has(p) !== next.has(p)) {
      const why = blocked(r, p, next.has(p));
      if (why) return why;
    }
    return null;
  };

  const editable = roles.filter((r) => !r.isOwnerRole);
  const changedRoles = editable.filter((r) => !same(perms.get(r.id)!, saved.get(r.id)!));
  const cellChanged = (r: MatrixRole, row: AreaRow) => rowPermissions(row).some((p) => perms.get(r.id)!.has(p) !== saved.get(r.id)!.has(p));
  const rows = AREA_ROWS.filter((row) => {
    if (area && row.area.key !== area) return false;
    if (!rowMatches(row, q)) return false;
    if (onlyChanged && !editable.some((r) => cellChanged(r, row))) return false;
    if (onlyDiffer) {
      const levels = new Set(editable.map((r) => levelIndex(row, perms.get(r.id)!)));
      if (levels.size < 2) return false;
    }
    return true;
  });

  const setLevel = (r: MatrixRole, row: AreaRow, i: number) => {
    setDone(null);
    const next = new Map(perms);
    next.set(r.id, withLevel(row, perms.get(r.id)!, i));
    setPerms(next);
  };

  const save = () => {
    setDone(null);
    const list = changedRoles;
    void sync.open({
      label: list.length === 1 ? `${list[0].name} role` : `Roles: ${list.map((r) => r.name).join(", ")}`.slice(0, 120),
      changes: list.map((r) => ({
        type: "role",
        item: r.id,
        value: {
          name: r.name,
          description: r.description,
          permissions: [...perms.get(r.id)!],
          maxDiscountPct: r.maxDiscountPct,
          defaultScope: r.defaultScope,
          moneyLimits: r.moneyLimits,
        },
      })),
      onDone: (res) => {
        setSaved(new Map(perms));
        setDone(res.status === "scheduled" || res.shops || res.kept ? syncedText(res) : `Saved ${list.length} ${list.length === 1 ? "role" : "roles"}.`);
      },
    });
  };

  return (
    <div className="space-y-3 pb-24">
      {readOnly && <Notice tone="blue">{readOnly}</Notice>}
      <p className="text-xs text-zinc-500">
        Under each level, how far it reaches: <b>Own data only</b> (their own column, clients, timesheet or numbers), <b>Assigned shops</b> (the shops each person is given) or{" "}
        <b>All shops</b> (a role that starts with every shop, records every shop shares, or every shop&apos;s reports). Reports reach as far as the role&apos;s Report scope.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Input className="max-w-xs" placeholder="Search permissions, e.g. refund or quickbooks" aria-label="Search permissions" value={q} onChange={(e) => setQ(e.target.value)} />
        <Select className="w-60" aria-label="Area" value={area} onChange={(e) => setArea(e.target.value)}>
          <option value="">Every area</option>
          {AREAS.map((a) => (
            <option key={a.key} value={a.key}>
              {a.label}
            </option>
          ))}
        </Select>
        <label className="flex items-center gap-1.5 text-sm text-zinc-600">
          <input type="checkbox" checked={onlyDiffer} onChange={(e) => setOnlyDiffer(e.target.checked)} />
          Only where roles differ
        </label>
        <label className="flex items-center gap-1.5 text-sm text-zinc-600">
          <input type="checkbox" checked={onlyChanged} onChange={(e) => setOnlyChanged(e.target.checked)} />
          Only unsaved changes
        </label>
        <span className="ml-auto text-xs text-zinc-500">{rows.length} of {AREA_ROWS.length} settings</span>
      </div>
      <Card className="overflow-hidden">
        <div className="max-h-[70vh] overflow-auto">
          <table className="w-full border-separate border-spacing-0 text-sm" data-testid="role-matrix">
            <thead>
              <tr>
                <th className="sticky left-0 top-0 z-20 min-w-[16rem] border-b border-zinc-200 bg-zinc-50 px-3 py-2 text-left text-xs font-medium text-zinc-500">Permission</th>
                {roles.map((r) => (
                  <th key={r.id} className="sticky top-0 z-10 min-w-[8.5rem] border-b border-l border-zinc-200 bg-zinc-50 px-2 py-2 text-left align-bottom text-xs font-medium">
                    <Link href={`/admin/permissions/roles/${r.id}`} className="block text-zinc-800 hover:underline">
                      {r.name}
                    </Link>
                    <span className="font-normal text-zinc-500">
                      {r.key ? "built-in" : "custom"} · {r.people} {r.people === 1 ? "person" : "people"}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {AREAS.map((a) => {
                const mine = rows.filter((row) => row.area.key === a.key);
                if (!mine.length) return null;
                return (
                  <Fragment key={a.key}>
                    <tr>
                      <th colSpan={roles.length + 1} className="sticky left-0 border-b border-zinc-100 bg-white px-3 pb-1 pt-3 text-left text-xs font-semibold uppercase tracking-wide text-zinc-500">
                        {a.label}
                        {a.hint && <span className="ml-2 font-normal normal-case tracking-normal text-zinc-400">{a.hint}</span>}
                      </th>
                    </tr>
                    {mine.map((row) => {
                      const tags = [...new Set(rowPermissions(row).map(permissionTag).filter(Boolean))];
                      return (
                        <tr key={row.id} data-row={row.id}>
                          <th scope="row" className="sticky left-0 z-[1] border-b border-zinc-100 bg-white px-3 py-1 text-left font-normal" title={rowPermissions(row).map((p) => `${permissionLabel(p)} (${p})`).join("\n")}>
                            <div className="text-zinc-800">{row.label}</div>
                            {(row.hint || tags.length > 0) && <div className="text-[11px] text-zinc-400">{[row.hint, ...tags].filter(Boolean).join(" · ")}</div>}
                          </th>
                          {roles.map((r) => {
                            if (r.isOwnerRole)
                              return (
                                <td key={r.id} className="border-b border-l border-zinc-100 px-2 py-1 text-xs text-zinc-500">
                                  {row.levels[row.levels.length - 1].label}
                                  <div className="pt-0.5 text-[10px] text-zinc-400">{REACH_LABEL.all}</div>
                                </td>
                              );
                            const i = levelIndex(row, perms.get(r.id)!);
                            const changed = cellChanged(r, row);
                            const reach = heldReach(row, perms.get(r.id)!, r.defaultScope === "all");
                            return (
                              <td key={r.id} className={cx("border-b border-l border-zinc-100 px-1 py-1", changed && "bg-amber-50")}>
                                <Select
                                  aria-label={`${r.name}: ${row.label}`}
                                  className={cx("w-full pl-2 text-xs", i <= 0 && row.levels[0]?.key === "none" ? "text-zinc-400" : "font-medium text-zinc-800")}
                                  value={i}
                                  disabled={locked}
                                  onChange={(e) => setLevel(r, row, Number(e.target.value))}
                                >
                                  {i === -1 && (
                                    <option value={-1} disabled>
                                      Custom
                                    </option>
                                  )}
                                  {row.levels.map((l, li) => {
                                    const why = li === i ? null : levelWhy(r, row, li);
                                    return (
                                      <option key={l.key} value={li} disabled={!!why} title={why ?? undefined}>
                                        {l.label}
                                        {why ? ` (${why.toLowerCase()})` : ""}
                                      </option>
                                    );
                                  })}
                                </Select>
                                {reach && (
                                  <div className="px-1 pt-0.5 text-[10px] text-zinc-400" data-reach={reach}>
                                    {REACH_LABEL[reach]}
                                  </div>
                                )}
                              </td>
                            );
                          })}
                        </tr>
                      );
                    })}
                  </Fragment>
                );
              })}
              {!rows.length && (
                <tr>
                  <td colSpan={roles.length + 1} className="px-4 py-8 text-center text-zinc-500">
                    Nothing matches.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
      {!locked && (
        <div className="fixed inset-x-0 bottom-0 z-20 border-t border-zinc-200 bg-white/95 backdrop-blur lg:left-60">
          <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-3 px-4 py-3 text-sm">
            {sync.error ? (
              <span className="text-red-600">{sync.error}</span>
            ) : done && !changedRoles.length ? (
              <span className="text-green-700">{done}</span>
            ) : (
              <span className="text-zinc-500" data-testid="matrix-status">
                {changedRoles.length ? `${changedRoles.length} ${changedRoles.length === 1 ? "role" : "roles"} changed: ${changedRoles.map((r) => r.name).join(", ")}` : "No changes"}
              </span>
            )}
            <div className="ml-auto flex gap-2">
              <Button type="button" variant="secondary" disabled={!changedRoles.length || sync.pending} onClick={() => setPerms(saved)}>
                Discard
              </Button>
              <Button type="button" variant="dark" disabled={!changedRoles.length || sync.pending} onClick={save}>
                {sync.pending ? "Saving…" : "Save changes"}
              </Button>
            </div>
          </div>
        </div>
      )}
      {sync.dialog}
    </div>
  );
}
