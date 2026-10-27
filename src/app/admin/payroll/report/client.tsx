"use client";

import { useState } from "react";
import { Button, Input, Select } from "@/components/ui";
import { useAction } from "@/components/use-action";
import { OVERRIDABLE, OVERRIDE_LABEL, type Overridable } from "@/domain/payroll/calc";
import { setOverrideAction } from "../actions";

export function OverrideForm({ shopId, periodStart, staffId, current }: { shopId: string; periodStart: string; staffId: string; current: Partial<Record<Overridable, { value: number; reason: string }>> }) {
  const { pending, error, run } = useAction();
  const [field, setField] = useState<Overridable>("workedHours");
  const [value, setValue] = useState("");
  const [reason, setReason] = useState("");
  return (
    <div className="space-y-2">
      {Object.entries(current).map(([k, o]) => (
        <div key={k} className="flex items-center gap-2 text-xs">
          <span className="font-medium">{OVERRIDE_LABEL[k as Overridable]}</span> typed as {o!.value} <span className="text-zinc-500">({o!.reason})</span>
          <button
            className="text-red-700 underline disabled:opacity-50"
            disabled={pending}
            onClick={() => run(() => setOverrideAction({ shopId, periodStart, staffId, field: k, value: null, reason: "" }))}
          >
            Remove
          </button>
        </div>
      ))}
      <div className="flex flex-wrap items-end gap-2">
        <Select aria-label="Value to type over" value={field} onChange={(e) => setField(e.target.value as Overridable)} className="h-8 w-40 text-xs">
          {OVERRIDABLE.map((k) => (
            <option key={k} value={k}>
              {OVERRIDE_LABEL[k]}
            </option>
          ))}
        </Select>
        <Input aria-label="New value" inputMode="decimal" placeholder="Value" value={value} onChange={(e) => setValue(e.target.value)} className="h-8 w-24 text-xs" />
        <Input aria-label="Reason" placeholder="Reason (required)" value={reason} onChange={(e) => setReason(e.target.value)} className="h-8 w-64 text-xs" />
        <Button
          size="sm"
          variant="secondary"
          disabled={pending || !value.trim() || !reason.trim()}
          onClick={() =>
            run(
              () => setOverrideAction({ shopId, periodStart, staffId, field, value: Number(value), reason }),
              () => {
                setValue("");
                setReason("");
              },
            )
          }
        >
          Type over
        </Button>
      </div>
      {error && <p className="text-xs text-red-700">{error}</p>}
    </div>
  );
}
