"use client";

import { useState } from "react";
import { Card, CardHeader, Field, Input, Select } from "@/components/ui";
import { FAMILY_LIMITS, type FamilySettings } from "@/domain/family";
import { saveFamilySettingsAction } from "../customers/family-actions";
import { SaveBar, useSave } from "./editors";

export function FamilyEditor({ initial }: { initial: FamilySettings }) {
  const { pending, msg, save } = useSave();
  const [v, setV] = useState(initial);
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
      <SaveBar pending={pending} msg={msg} onClick={() => save(() => saveFamilySettingsAction(v))} />
    </Card>
  );
}
