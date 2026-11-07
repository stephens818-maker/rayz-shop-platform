"use client";

import { useState } from "react";
import { Button } from "@/components/ui";
import { useAction } from "@/components/use-action";
import { acceptDurationSuggestionAction } from "../../booking-times/actions";

export function AcceptSuggestion(props: { staffId: string; serviceId: string; shopId: string; minutes: number; evidence: { n: number; avgMin: number; medianMin: number; fromMin: number }; label: string }) {
  const { pending, error, run } = useAction();
  const [done, setDone] = useState(false);
  const { label, ...input } = props;
  if (done) return <span className="text-xs text-emerald-700">Saved: {props.minutes} min</span>;
  return (
    <span className="inline-flex flex-col items-end gap-0.5">
      <Button size="sm" variant="secondary" disabled={pending} title={label} onClick={() => run(() => acceptDurationSuggestionAction(input), () => setDone(true))}>
        {pending ? "Saving…" : `Use ${props.minutes} min`}
      </Button>
      {error && <span className="text-xs text-red-700">{error}</span>}
    </span>
  );
}
