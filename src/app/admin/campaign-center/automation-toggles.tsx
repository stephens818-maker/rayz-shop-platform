"use client";

import { useState } from "react";
import { cx } from "@/components/ui";
import { useAction } from "@/components/use-action";
import { setLocationAutomationAction } from "./actions";

interface Loc {
  shopId: string;
  shopName: string;
  enabled: boolean;
  templates: unknown;
  settings: Record<string, number> | null;
}

/** On or off at each of the person's locations. Turning one on or off keeps the location's own wording. */
export function AutomationToggles({ campaignId, locations, disabled }: { campaignId: string; locations: Loc[]; disabled: boolean }) {
  const { pending, error, run } = useAction();
  const [on, setOn] = useState(() => Object.fromEntries(locations.map((l) => [l.shopId, l.enabled])));
  return (
    <div className="flex max-w-xl flex-wrap items-start gap-1.5 md:justify-end">
      {locations.map((l) => (
        <button
          key={l.shopId}
          type="button"
          disabled={disabled || pending}
          aria-pressed={on[l.shopId]}
          onClick={() => {
            const next = !on[l.shopId];
            run(
              () => setLocationAutomationAction({ campaignId, shopId: l.shopId, enabled: next, templates: l.templates ?? null, settings: l.settings }),
              () => setOn((x) => ({ ...x, [l.shopId]: next })),
            );
          }}
          className={cx("rounded-full px-2.5 py-1 text-xs ring-1 transition disabled:cursor-not-allowed", on[l.shopId] ? "bg-emerald-600 text-white ring-emerald-600" : "bg-white text-zinc-600 ring-zinc-300 hover:ring-zinc-500")}
        >
          {on[l.shopId] ? "✓ " : ""}
          {l.shopName}
        </button>
      ))}
      {error && <p className="w-full text-right text-xs text-red-700">{error}</p>}
    </div>
  );
}
