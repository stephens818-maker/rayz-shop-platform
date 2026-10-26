"use client";

import { useState } from "react";
import { Button, Input, Select } from "@/components/ui";
import { useAction } from "@/components/use-action";
import { SyncMsg, useSettingSync } from "@/components/brand-sync";
import { ListShops, useListSync } from "@/components/list-sync";
import {
  FIELD_KINDS,
  FIELD_KIND_LABEL,
  OPTIONAL_EXPORT,
  OPTIONAL_EXPORT_LABEL,
  type CompensationSettings,
  type FieldKind,
} from "@/domain/compensation";
import { saveFieldAction, setFieldActiveAction } from "./actions";

const Check = ({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}) => (
  <label
    className={`flex items-start gap-2 text-sm ${disabled ? "opacity-50" : ""}`}
  >
    <input
      type="checkbox"
      className="mt-1"
      checked={checked}
      disabled={disabled}
      onChange={(e) => onChange(e.target.checked)}
    />
    <span>
      {label}
      {hint && <span className="block text-xs text-zinc-500">{hint}</span>}
    </span>
  </label>
);

export function SettingsForm({ initial }: { initial: CompensationSettings }) {
  const { pending, msg, saveSetting, dialog } = useSettingSync("compensation");
  const [v, setV] = useState(initial);
  const put = (x: Partial<CompensationSettings>) => setV({ ...v, ...x });
  const off = !v.enabled;
  return (
    <div className="space-y-3 px-4 py-3">
      <Check
        label="Use compensation fields"
        hint="Adds a Compensation tab to employees, the Commission Payout report and My pay. Off: none of it shows and payroll, tips and the iSolved files are exactly as before."
        checked={v.enabled}
        onChange={(x) => put({ enabled: x })}
      />
      <Check
        label="Payroll uses each employee's plan"
        hint="Hourly rates, commission (overrides and tiers included) and the guaranteed minimum come from the plan in effect. Anyone without a plan, and anything a plan leaves blank, keeps Payroll setup's rates."
        checked={v.payrollUsesPlans}
        disabled={off}
        onChange={(x) => put({ payrollUsesPlans: x })}
      />
      <Check
        label="Show a pay estimate on My pay"
        hint="People with “See their own pay” get an estimate of the current pay period from the Payroll Report's numbers. Only their own."
        checked={v.payEstimate}
        disabled={off}
        onChange={(x) => put({ payEstimate: x })}
      />
      <div className="space-y-2 rounded-lg bg-zinc-50 p-3">
        <p className="text-xs font-medium text-zinc-600">
          Extra iSolved columns, added after the standard ones in every
          shop&apos;s file
        </p>
        {OPTIONAL_EXPORT.map((k) => (
          <div key={k} className="flex flex-wrap items-center gap-2">
            <Check
              label={OPTIONAL_EXPORT_LABEL[k]}
              checked={v.exportColumns[k].on}
              disabled={off}
              onChange={(x) =>
                put({
                  exportColumns: {
                    ...v.exportColumns,
                    [k]: { ...v.exportColumns[k], on: x },
                  },
                })
              }
            />
            <Input
              aria-label={`${OPTIONAL_EXPORT_LABEL[k]} header`}
              value={v.exportColumns[k].header}
              disabled={off}
              onChange={(e) =>
                put({
                  exportColumns: {
                    ...v.exportColumns,
                    [k]: { ...v.exportColumns[k], header: e.target.value },
                  },
                })
              }
              className="h-8 w-72 text-xs"
            />
          </div>
        ))}
        <label className="flex flex-wrap items-center gap-2 text-sm">
          <span>
            Guaranteed minimum top-up column (only in a file where someone has a
            top-up)
          </span>
          <Input
            value={v.guaranteeHeader}
            disabled={off}
            onChange={(e) => put({ guaranteeHeader: e.target.value })}
            className="h-8 w-72 text-xs"
          />
        </label>
        <p className="text-xs text-zinc-500">
          The earning codes are to confirm with the payroll provider. A locked
          period&apos;s file keeps the columns it was approved with.
        </p>
      </div>
      <div className="flex items-center gap-3">
        <Button size="sm" disabled={pending} onClick={() => saveSetting(v)}>
          Save settings
        </Button>
        <SyncMsg msg={msg} />
      </div>
      {dialog}
    </div>
  );
}

export interface FieldDefRow {
  id: string;
  label: string;
  kind: FieldKind;
  options: string[];
  position: number;
  active: boolean;
  used: number;
}

export function FieldDefForm({
  f,
  brand,
}: {
  f: FieldDefRow | null;
  brand: boolean;
}) {
  const { pending, error, run } = useAction();
  const shops = useListSync("staff_field");
  const [v, setV] = useState({
    label: f?.label ?? "",
    kind: f?.kind ?? ("text" as FieldKind),
    options: (f?.options ?? []).join(", "),
    position: f?.position ?? 100,
  });
  const save = () =>
    run(
      () =>
        saveFieldAction(f?.id ?? null, {
          label: v.label,
          kind: v.kind,
          options:
            v.kind === "dropdown"
              ? v.options
                  .split(",")
                  .map((o) => o.trim())
                  .filter(Boolean)
              : [],
          position: Number(v.position) || 0,
        }),
      (id) => {
        if (f) return;
        setV({ label: "", kind: "text", options: "", position: 100 });
        if (brand) shops.offer(id, v.label);
      },
    );
  return (
    <tr
      className={`border-t border-zinc-100 align-top ${f && !f.active ? "opacity-60" : ""}`}
    >
      <td className="px-2 py-1.5">
        <Input
          aria-label="Field name"
          placeholder={f ? undefined : "New field, e.g. Start date"}
          value={v.label}
          maxLength={60}
          onChange={(e) => setV({ ...v, label: e.target.value })}
          className="h-8 w-56 text-xs"
        />
      </td>
      <td className="px-2 py-1.5">
        <Select
          aria-label="Type"
          value={v.kind}
          disabled={!!f}
          onChange={(e) => setV({ ...v, kind: e.target.value as FieldKind })}
          className="h-8 w-32 text-xs"
        >
          {FIELD_KINDS.map((k) => (
            <option key={k} value={k}>
              {FIELD_KIND_LABEL[k]}
            </option>
          ))}
        </Select>
      </td>
      <td className="px-2 py-1.5">
        {v.kind === "dropdown" ? (
          <Input
            aria-label="Choices, comma separated"
            placeholder="Choice 1, Choice 2"
            value={v.options}
            onChange={(e) => setV({ ...v, options: e.target.value })}
            className="h-8 w-64 text-xs"
          />
        ) : (
          <span className="text-xs text-zinc-400">—</span>
        )}
      </td>
      <td className="px-2 py-1.5">
        <Input
          aria-label="Order"
          type="number"
          value={v.position}
          onChange={(e) => setV({ ...v, position: Number(e.target.value) })}
          className="h-8 w-20 text-xs"
        />
      </td>
      <td className="px-2 py-1.5 text-xs text-zinc-500">
        {f ? `${f.used} ${f.used === 1 ? "person" : "people"}` : ""}
      </td>
      <td className="space-x-1 px-2 py-1.5 whitespace-nowrap">
        <Button size="sm" variant="secondary" disabled={pending} onClick={save}>
          {f ? "Save" : "Add field"}
        </Button>
        {f && (
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() => run(() => setFieldActiveAction(f.id, !f.active))}
          >
            {f.active ? "Retire" : "Restore"}
          </Button>
        )}
        {brand && f?.active && (
          <ListShops
            list="staff_field"
            id={f.id}
            label={f.label}
            disabled={pending}
          />
        )}
        <SyncMsg msg={shops.msg} />
        {error && (
          <p className="mt-1 max-w-60 text-xs whitespace-normal text-red-700">
            {error}
          </p>
        )}
        {shops.dialog}
      </td>
    </tr>
  );
}
