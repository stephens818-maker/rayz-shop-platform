"use client";

import { Button } from "@/components/ui";
import { useAction } from "@/components/use-action";
import { recordTaxCheckAction, refreshAccountAction } from "./actions";

export function RefreshAccount({ staffId }: { staffId: string }) {
  const { pending, error, run } = useAction();
  return (
    <span className="inline-flex flex-col items-end gap-1">
      <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => refreshAccountAction(staffId), undefined, "Checked with Stripe")}>
        Check with Stripe
      </Button>
      {error && <span className="text-xs text-red-600">{error}</span>}
    </span>
  );
}

export function RecordTaxCheck({ taxYear, recorded }: { taxYear: number; recorded: boolean }) {
  const { pending, error, run } = useAction();
  return (
    <span className="inline-flex flex-col gap-1">
      <Button size="sm" variant={recorded ? "secondary" : "primary"} disabled={pending} onClick={() => run(() => recordTaxCheckAction(taxYear), undefined, `${taxYear} check recorded`)}>
        {recorded ? `Record the ${taxYear} check again` : `I imported the exclusions: record the ${taxYear} check`}
      </Button>
      {error && <span className="text-xs text-red-600">{error}</span>}
    </span>
  );
}
