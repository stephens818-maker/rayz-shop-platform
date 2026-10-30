"use client";

import { useBrandSync } from "@/components/brand-sync";
import type { AppSwitch } from "@/server/app-switches";

export function SwitchToggle({ k, label, on, lockedOff }: { k: AppSwitch; label: string; on: boolean; lockedOff: boolean }) {
  const sync = useBrandSync();
  return (
    <>
      <label className="flex items-center justify-between gap-4 px-4 py-3" data-testid={`switch-${k}`}>
        <span>
          <span className="block text-sm font-medium">{label}</span>
          {lockedOff && <span className="block text-xs text-amber-700">Held off by APP_KILL in the server settings.</span>}
          {sync.error && <span className="block text-xs text-red-700">{sync.error}</span>}
        </span>
        <input
          type="checkbox"
          className="h-5 w-5"
          checked={on}
          disabled={sync.pending || lockedOff}
          onChange={(e) => void sync.open({ label: `${label}: ${e.target.checked ? "on" : "off"}`, changes: [{ type: "app", item: "switches", value: { [k]: e.target.checked } }] })}
        />
      </label>
      {sync.dialog}
    </>
  );
}
