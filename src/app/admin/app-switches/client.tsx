"use client";

import { useAction } from "@/components/use-action";
import { saveAppSwitchAction } from "./actions";

export function SwitchToggle({ k, label, on, lockedOff }: { k: string; label: string; on: boolean; lockedOff: boolean }) {
  const { pending, error, run } = useAction();
  return (
    <label className="flex items-center justify-between gap-4 px-4 py-3" data-testid={`switch-${k}`}>
      <span>
        <span className="block text-sm font-medium">{label}</span>
        {lockedOff && <span className="block text-xs text-amber-700">Held off by APP_KILL in the server settings.</span>}
        {error && <span className="block text-xs text-red-700">{error}</span>}
      </span>
      <input type="checkbox" className="h-5 w-5" checked={on} disabled={pending || lockedOff} onChange={(e) => run(() => saveAppSwitchAction(k, e.target.checked))} />
    </label>
  );
}
