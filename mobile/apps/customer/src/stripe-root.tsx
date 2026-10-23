import type { ReactNode } from "react";

/** Web has no native Stripe view. Card numbers stay out of the app; the sandbox uses test last4 only. */
export function StripeRoot({ children }: { children: ReactNode }) {
  return children;
}
