"use client";

import { Fragment, useMemo, useState } from "react";
import { Badge, Card, CardHeader, Input, Select, cx } from "@/components/ui";
import { AREAS, AREA_ROWS, AreaRow, REACH_LABEL, SourceKind, heldReach, levelIndex, permissionSource, rowMatches, rowPermissions } from "@/domain/permission-areas";
import { MONEY_LIMITS, MoneyLimits, OverrideExpiry, Overrides, Permission, ShopScope, limitLabel, permissionLabel } from "@/domain/permissions";

/** One shop (or group of shops with the same access) as a column. */
export interface BreakdownColumn {
  key: string;
  label: string;
  /** The role they hold there. */
  role: string;
  isOwner: boolean;
  held: string[];
  fromRole: string[];
  granted: string[];
  scope: ShopScope;
  brandLevel: boolean;
  shopLogin: boolean;
  ownerMismatch: boolean;
  maxDiscountPct: number;
  limits: MoneyLimits;
}

const SOURCE_TONE: Record<SourceKind, string> = {
  owner: "text-zinc-700",
  role: "text-zinc-700",
  allowed: "text-emerald-700",
  denied: "text-red-700",
  grant: "text-sky-700",
  included: "text-zinc-600",
  blocked: "text-amber-800",
  none: "text-zinc-400",
};

/**
 * What someone can do, area by area and shop by shop, with where each permission comes from: the
 * role, a per-person override (and when it ends), a contact access grant, or the rule that keeps it off.
 */
export function AccessBreakdown({
  columns,
  overrides = {},
  expires = {},
  title = "Effective permissions",
  subtitle,
}: {
  columns: BreakdownColumn[];
  overrides?: Overrides;
  expires?: OverrideExpiry;
  title?: string;
  subtitle?: string;
}) {
  const [q, setQ] = useState("");
  const [area, setArea] = useState("");
  const [onlyHeld, setOnlyHeld] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const ctxs = useMemo(
    () =>
      columns.map((c) => ({
        ...c,
        heldSet: new Set(c.held as Permission[]),
        ctx: {
          isOwner: c.isOwner,
          held: new Set(c.held as Permission[]),
          fromRole: new Set(c.fromRole as Permission[]),
          overrides,
          expires,
          granted: new Set(c.granted as Permission[]),
          scope: c.scope,
          brandLevel: c.brandLevel,
          shopLogin: c.shopLogin,
          ownerMismatch: c.ownerMismatch,
        },
      })),
    [columns, overrides, expires],
  );
  const rows = AREA_ROWS.filter((r) => (!area || r.area.key === area) && rowMatches(r, q) && (!onlyHeld || ctxs.some((c) => rowPermissions(r).some((p) => c.heldSet.has(p)))));
  const touched = (r: AreaRow) => rowPermissions(r).filter((p) => p in overrides);
  const toggle = (id: string) => {
    const next = new Set(open);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setOpen(next);
  };

  return (
    <Card data-testid="access-breakdown">
      <CardHeader
        title={title}
        subtitle={subtitle ?? "Area by area, at each of their shops, with how far each reaches: own data only, their assigned shops or all shops. Click a row for each permission and where it comes from."}
        action={
          <label className="flex items-center gap-1.5 text-xs text-zinc-600">
            <input type="checkbox" checked={onlyHeld} onChange={(e) => setOnlyHeld(e.target.checked)} />
            Only what they have
          </label>
        }
      />
      <div className="flex flex-wrap gap-2 border-b border-zinc-100 px-4 py-3">
        <Input className="max-w-xs" placeholder="Search permissions" aria-label="Search permissions" value={q} onChange={(e) => setQ(e.target.value)} />
        <Select className="w-56" aria-label="Area" value={area} onChange={(e) => setArea(e.target.value)}>
          <option value="">Every area</option>
          {AREAS.map((a) => (
            <option key={a.key} value={a.key}>
              {a.label}
            </option>
          ))}
        </Select>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-zinc-50 text-xs text-zinc-500">
              <th className="px-4 py-2 text-left font-medium">Permission</th>
              {columns.map((c) => (
                <th key={c.key} className="min-w-[9rem] border-l border-zinc-100 px-3 py-2 text-left font-medium">
                  <div className="text-zinc-800">{c.label}</div>
                  <div className="font-normal">{c.role}</div>
                </th>
              ))}
            </tr>
            <tr className="border-t border-zinc-100 text-xs">
              <th className="px-4 py-2 text-left font-medium text-zinc-500">Limits</th>
              {columns.map((c) => (
                <td key={c.key} className="border-l border-zinc-100 px-3 py-2 align-top text-zinc-600" data-testid="limits">
                  {c.isOwner ? (
                    "No limits"
                  ) : (
                    <ul className="space-y-0.5">
                      <li>Discount: {c.held.includes("pos.discount") ? `${c.maxDiscountPct}%, ${limitLabel(c.limits.discountCents)}` : "none"}</li>
                      {MONEY_LIMITS.filter((l) => l.key !== "discountCents").map((l) => (
                        <li key={l.key}>
                          {l.label}: {l.perms.some((p) => c.held.includes(p)) ? limitLabel(c.limits[l.key]) : "none"}
                        </li>
                      ))}
                    </ul>
                  )}
                </td>
              ))}
            </tr>
          </thead>
          <tbody>
            {AREAS.map((a) => {
              const mine = rows.filter((r) => r.area.key === a.key);
              if (!mine.length) return null;
              return (
                <Fragment key={a.key}>
                  <tr className="border-t border-zinc-200 bg-zinc-50">
                    <th colSpan={columns.length + 1} className="px-4 py-1.5 text-left text-xs font-semibold uppercase tracking-wide text-zinc-500">
                      {a.label}
                    </th>
                  </tr>
                  {mine.map((r) => {
                    const o = touched(r);
                    const isOpen = open.has(r.id);
                    return (
                      <Fragment key={r.id}>
                        <tr className="border-t border-zinc-100" data-row={r.id}>
                          <th scope="row" className="px-4 py-1.5 text-left font-normal">
                            <button type="button" className="text-left hover:underline" aria-expanded={isOpen} onClick={() => toggle(r.id)}>
                              {r.label}
                            </button>
                            {o.length > 0 && (
                              <span className="ml-2">
                                <Badge tone={o.every((p) => overrides[p]) ? "green" : o.every((p) => !overrides[p]) ? "red" : "amber"}>
                                  {o.every((p) => overrides[p]) ? "allowed" : o.every((p) => !overrides[p]) ? "denied" : "override"}
                                  {o.some((p) => expires[p]) ? ` until ${o.map((p) => expires[p]).filter(Boolean).sort()[0]}` : ""}
                                </Badge>
                              </span>
                            )}
                          </th>
                          {ctxs.map((c) => {
                            const i = c.isOwner ? r.levels.length - 1 : levelIndex(r, c.heldSet);
                            const lvl = i >= 0 ? r.levels[i] : null;
                            const none = lvl && i === 0 && !lvl.adds.length && lvl.key === "none";
                            const reach = c.isOwner ? "all" : heldReach(r, c.heldSet, c.scope === "all");
                            return (
                              <td key={c.key} className={cx("border-l border-zinc-100 px-3 py-1.5", none ? "text-zinc-400" : "font-medium text-zinc-800")} data-cell={`${r.id}:${c.key}`}>
                                {lvl ? lvl.label : "Custom"}
                                {reach && (
                                  <span className="ml-1.5 text-[11px] font-normal text-zinc-400" data-reach={reach}>
                                    {REACH_LABEL[reach]}
                                  </span>
                                )}
                              </td>
                            );
                          })}
                        </tr>
                        {isOpen && (
                          <tr className="bg-zinc-50/60">
                            <td colSpan={columns.length + 1} className="px-4 py-2">
                              <table className="w-full text-xs">
                                <tbody>
                                  {rowPermissions(r).map((p) => (
                                    <tr key={p}>
                                      <td className="py-0.5 pr-3 text-zinc-700">
                                        {permissionLabel(p)} <span className="text-zinc-400">{p}</span>
                                      </td>
                                      {ctxs.map((c) => {
                                        const s = permissionSource(p, c.ctx);
                                        return (
                                          <td key={c.key} className={cx("py-0.5 pr-3", SOURCE_TONE[s.kind])}>
                                            {c.heldSet.has(p) || c.isOwner ? "✓ " : "✕ "}
                                            {s.text}
                                          </td>
                                        );
                                      })}
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </Fragment>
              );
            })}
            {!rows.length && (
              <tr>
                <td colSpan={columns.length + 1} className="px-4 py-6 text-center text-zinc-500">
                  Nothing matches.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
