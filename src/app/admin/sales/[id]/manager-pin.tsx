"use client";

import { Field, Input, Notice, Select } from "@/components/ui";

export interface ApprovalValue {
  staffId: string;
  pin: string;
}

/** A manager standing at the counter approves with their own time clock PIN. */
export function ManagerPin({ approvers, value, onChange, what }: { approvers: { id: string; label: string }[]; value: ApprovalValue; onChange: (v: ApprovalValue) => void; what: string }) {
  if (!approvers.length) return <Notice tone="amber">A manager needs to approve {what}, and no one here who can has set a time clock PIN yet.</Notice>;
  return (
    <div className="space-y-2 rounded-lg bg-amber-50 p-3 ring-1 ring-amber-200" data-testid="manager-pin">
      <div className="text-xs font-medium text-amber-900">A manager approves {what} with their PIN</div>
      <div className="grid grid-cols-[1fr_110px] gap-2">
        <Field label="Manager">
          <Select value={value.staffId} onChange={(e) => onChange({ ...value, staffId: e.target.value })}>
            <option value="">Pick…</option>
            {approvers.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="PIN">
          <Input type="password" inputMode="numeric" autoComplete="off" maxLength={8} value={value.pin} onChange={(e) => onChange({ ...value, pin: e.target.value.replace(/\D/g, "") })} />
        </Field>
      </div>
    </div>
  );
}

export const approvalReady = (needsPin: boolean, v: ApprovalValue) => !needsPin || (!!v.staffId && v.pin.length >= 4);
