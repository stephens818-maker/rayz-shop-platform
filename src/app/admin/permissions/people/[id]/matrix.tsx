"use client";

import { Card, CardHeader, cx } from "@/components/ui";
import { MATRIX_ACTIONS, MATRIX_AREAS, cellOverride, cellState, nextOverride, setCell, type MatrixCell } from "@/domain/permission-matrix";
import { Overrides, Permission, permissionLabel } from "@/domain/permissions";

const STATE_CLASS = { on: "bg-emerald-50 text-emerald-800", off: "bg-white text-zinc-400", partial: "bg-amber-50 text-amber-800", always: "bg-zinc-50 text-zinc-500" } as const;
const STATE_TEXT = { on: "Yes", off: "No", partial: "Part", always: "Always" } as const;

/**
 * Squire's area × action grid over this person's permissions. Clicking a cell goes role default →
 * allow → deny for every permission in it; the list below has each permission on its own.
 */
export function PermissionMatrix({
  overrides,
  has,
  fromRole,
  blocked,
  onChange,
}: {
  overrides: Overrides;
  /** What they'd have with these overrides. */
  has: ReadonlySet<Permission>;
  fromRole: ReadonlySet<Permission>;
  /** Why this person can't be given (or have taken away) that permission by the editor, or null. */
  blocked: (p: Permission, v: boolean | null) => boolean;
  onChange: (o: Overrides) => void;
}) {
  const cell = (c: MatrixCell | undefined, label: string, key: string, colSpan?: number) => {
    if (!c) return <td key={key} className="border-l border-zinc-100 px-1 py-1 text-center text-zinc-200" aria-label={`${label}: not applicable`}>·</td>;
    const state = cellState(has, c);
    if (c === "always")
      return (
        <td key={key} className="border-l border-zinc-100 px-1 py-1 text-center">
          <span className={cx("inline-block w-full rounded px-1 py-1 text-[11px]", STATE_CLASS.always)} title="Every staff login can do this">
            {STATE_TEXT.always}
          </span>
        </td>
      );
    const o = cellOverride(overrides, c);
    const next = nextOverride(o);
    const disabled = c.some((p) => blocked(p, next));
    const title = [
      ...c.map((p) => `${has.has(p) ? "✓" : "✕"} ${permissionLabel(p)}${fromRole.has(p) ? " (role: yes)" : " (role: no)"}`),
      o === true ? "Allowed for this person" : o === false ? "Denied for this person" : o === "mixed" ? "Mixed overrides" : "Role default",
      disabled ? "You can't change this one" : `Click: ${next === true ? "allow" : next === false ? "deny" : "back to the role"}`,
    ].join("\n");
    return (
      <td key={key} colSpan={colSpan} className="border-l border-zinc-100 px-1 py-1 text-center">
        <button
          type="button"
          disabled={disabled}
          title={title}
          aria-label={`${label}: ${STATE_TEXT[state]}${o === true ? ", allowed" : o === false ? ", denied" : ""}`}
          onClick={() => onChange(setCell(overrides, c, next))}
          className={cx(
            "w-full rounded px-1 py-1 text-[11px] font-medium ring-1 disabled:cursor-not-allowed disabled:opacity-50",
            STATE_CLASS[state],
            o === true ? "ring-2 ring-emerald-600" : o === false ? "ring-2 ring-red-600" : o === "mixed" ? "ring-amber-500" : "ring-zinc-200 hover:ring-zinc-400",
          )}
        >
          {STATE_TEXT[state]}
          {o === true ? " ↑" : o === false ? " ↓" : ""}
        </button>
      </td>
    );
  };

  return (
    <Card>
      <CardHeader
        title="Permission matrix"
        subtitle="What they can do in each area. Click a cell to allow or deny it for this person only (↑ allowed, ↓ denied); click again to go back to the role. Hover for the permissions behind it."
      />
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-sm" data-testid="permission-matrix">
          <thead>
            <tr className="bg-zinc-50 text-xs text-zinc-500">
              <th className="px-3 py-2 text-left font-medium">Area</th>
              {MATRIX_ACTIONS.map((a) => (
                <th key={a.key} className="w-[11%] border-l border-zinc-100 px-1 py-2 text-center font-medium">
                  {a.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            {MATRIX_AREAS.map((area) => (
              <tr key={area.key}>
                <th scope="row" className="whitespace-nowrap px-3 py-1 text-left font-medium text-zinc-800">
                  {area.label}
                </th>
                {area.single ? (
                  cell(area.single, area.label, "single", MATRIX_ACTIONS.length)
                ) : (
                  MATRIX_ACTIONS.map((a) => cell(area.cells?.[a.key], `${area.label} ${a.label}`, a.key))
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap gap-3 border-t border-zinc-100 px-4 py-2 text-xs text-zinc-500">
        <span>
          <span className={cx("rounded px-1.5", STATE_CLASS.on)}>Yes</span> they can
        </span>
        <span>
          <span className={cx("rounded px-1.5", STATE_CLASS.partial)}>Part</span> some of the permissions behind it
        </span>
        <span>
          <span className="rounded px-1.5 ring-2 ring-emerald-600">↑</span> allowed for them
        </span>
        <span>
          <span className="rounded px-1.5 ring-2 ring-red-600">↓</span> denied for them
        </span>
      </div>
    </Card>
  );
}
