"use client";

import { useState, useTransition } from "react";
import { Button, Input, Notice } from "@/components/ui";
import { setStaffPinAction } from "@/app/admin/clock/actions";

export function StaffPinForm({ staffId, hasPin }: { staffId: string; hasPin: boolean }) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pending, start] = useTransition();
  return (
    <form
      className="flex flex-wrap items-end gap-2 p-4"
      data-testid="set-pin"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        start(async () => {
          const r = await setStaffPinAction(staffId, pin);
          if (!r.ok) return setError(r.error);
          setDone(true);
          setPin("");
        });
      }}
    >
      <label className="text-sm">
        {hasPin ? "New PIN" : "PIN"}
        <Input className="mt-1 w-32" inputMode="numeric" autoComplete="off" maxLength={6} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))} />
      </label>
      <Button type="submit" disabled={pending || pin.length < 4}>
        {hasPin ? "Reset PIN" : "Set PIN"}
      </Button>
      {error && <Notice tone="red">{error}</Notice>}
      {done && <Notice tone="green">PIN saved. It works on the front-desk clock and the calendar.</Notice>}
    </form>
  );
}
