import { StripeProvider } from "@stripe/stripe-react-native";
import type { ReactElement } from "react";

const publishableKey = process.env.EXPO_PUBLIC_STRIPE_PK ?? "pk_test_sandbox_rayz";

/** Test-mode provider. The app never reads a card number; Stripe's sheet does, when a live SetupIntent is returned. */
export function StripeRoot({ children }: { children: ReactElement }) {
  return (
    <StripeProvider publishableKey={publishableKey} merchantIdentifier="merchant.com.getsquire.SquireRayzBarbershop">
      {children}
    </StripeProvider>
  );
}
