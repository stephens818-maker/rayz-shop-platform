"use client";

import { useState } from "react";
import { cx } from "@/components/ui";
import { useAction } from "@/components/use-action";
import { setSequenceEnabledAction } from "./actions";

export function SequenceToggle({ id, enabled, disabled }: { id: string; enabled: boolean; disabled: boolean }) {
  const { pending, error, run } = useAction();
  const [on, setOn] = useState(enabled);
  return (
    <div className="text-right">
      <button
        type="button"
        disabled={disabled || pending}
        aria-pressed={on}
        onClick={() => run(() => setSequenceEnabledAction(id, !on), () => setOn(!on))}
        className={cx("rounded-full px-3 py-1 text-xs ring-1 transition disabled:cursor-not-allowed", on ? "bg-emerald-600 text-white ring-emerald-600" : "bg-white text-zinc-600 ring-zinc-300 hover:ring-zinc-500")}
      >
        {on ? "✓ On" : "Off"}
      </button>
      {error && <p className="mt-1 max-w-xs text-xs text-red-700">{error}</p>}
    </div>
  );
}
