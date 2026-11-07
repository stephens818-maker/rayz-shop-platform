"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";
import { buyAgainAction } from "../product-actions";

/** One tap: the product on the client's ticket at this shop (theirs today, or a new one), then checkout. */
export function BuyAgainButton({ customerId, productId, qty, disabled, title }: { customerId: string; productId: string; qty: number; disabled?: boolean; title?: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="inline-flex flex-col items-end gap-0.5">
      <Button
        size="sm"
        variant="secondary"
        disabled={disabled || pending}
        title={title}
        data-testid="profile-buy-again"
        onClick={() =>
          start(async () => {
            setError(null);
            const r = await buyAgainAction(customerId, productId, qty);
            if (!r.ok) return setError(r.error);
            router.push(`/admin/checkout/${r.data.saleId}`);
          })
        }
      >
        Buy again
      </Button>
      {error && <span className="max-w-48 text-right text-[11px] text-red-700">{error}</span>}
    </span>
  );
}
