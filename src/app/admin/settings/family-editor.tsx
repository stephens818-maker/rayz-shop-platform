"use client";

import { useState } from "react";
import { Card, CardHeader, Field, Input, Select } from "@/components/ui";
import { FAMILY_LIMITS, type FamilySettings } from "@/domain/family";
import { saveFamilySettingsAction } from "../customers/family-actions";
import { SaveBar, useSave } from "./editors";

export function FamilyEditor({ initial }: { initial: FamilySettings }) {
  const { pending, msg, save } = useSave();
  const [v, setV] = useState(initial);
  const [depositText, setDepositText] = useState(initial.groupDepositCents ? (initial.groupDepositCents / 100).toFixed(2) : "0");
  return (
    <Card data-testid="family-settings">
      <CardHeader
        title="Family accounts (brand-wide)"
        subtitle="A parent's profile can hold child profiles. Children have no login or contact details: reminders, receipts and marketing go to the parent, under the parent's consent."
      />
      <div className="grid gap-3 p-4 sm:grid-cols-3">
        <Field label="Children per account" hint="0 turns family accounts off">
          <Input inputMode="numeric" value={v.maxChildren} onChange={(e) => setV({ ...v, maxChildren: Math.min(FAMILY_LIMITS.maxChildren, Number(e.target.value.replace(/\D/g, "")) || 0) })} />
        </Field>
        <Field label="Children's visits earn loyalty for">
          <Select value={v.loyalty} onChange={(e) => setV({ ...v, loyalty: e.target.value as FamilySettings["loyalty"] })}>
            <option value="household">The household (the parent&apos;s card)</option>
            <option value="individual">Each child (their own card)</option>
          </Select>
        </Field>
        <Field label="Own account from age" hint={`${FAMILY_LIMITS.minSplitAge} to ${FAMILY_LIMITS.maxSplitAge}`}>
          <Input inputMode="numeric" value={v.splitAge} onChange={(e) => setV({ ...v, splitAge: Number(e.target.value.replace(/\D/g, "")) || 0 })} />
        </Field>
      </div>
      <div className="grid gap-3 border-t border-zinc-100 p-4 sm:grid-cols-3" data-testid="group-deposit-settings">
        <p className="text-sm text-zinc-600 sm:col-span-3">
          Family bookings: one deposit for the whole group, taken at the desk and applied to the bill. Cancelling in time gets it back; a whole-group no-show or a late cancel can keep it.
        </p>
        <Field label="Deposit per family booking ($)" hint="0 for no deposit; up to $200">
          <Input
            inputMode="decimal"
            value={depositText}
            onChange={(e) => {
              setDepositText(e.target.value);
              const cents = Math.round((Number(e.target.value.replace(/[^0-9.]/g, "")) || 0) * 100);
              setV({ ...v, groupDepositCents: Math.min(20_000, cents) });
            }}
          />
        </Field>
        <Field label="For groups of at least" hint="2 to 7 people">
          <Select value={v.groupDepositFrom} onChange={(e) => setV({ ...v, groupDepositFrom: Number(e.target.value) })}>
            {[2, 3, 4, 5, 6, 7].map((n) => (
              <option key={n} value={n}>
                {n} people
              </option>
            ))}
          </Select>
        </Field>
        <Field label="No-show or late cancel">
          <Select value={v.groupNoShowForfeit ? "keep" : "return"} onChange={(e) => setV({ ...v, groupNoShowForfeit: e.target.value === "keep" })}>
            <option value="keep">Keep the deposit</option>
            <option value="return">Give it back</option>
          </Select>
        </Field>
      </div>
      <SaveBar pending={pending} msg={msg} onClick={() => save(() => saveFamilySettingsAction(v))} />
    </Card>
  );
}
