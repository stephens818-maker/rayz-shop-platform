"use client";

import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import { loadStripe, type Stripe } from "@stripe/stripe-js";
import { useEffect, useMemo, useState } from "react";
import { Button, Notice } from "@/components/ui";

let stripePromise: Promise<Stripe | null> | null = null;
const getStripe = (pk: string) => (stripePromise ??= loadStripe(pk));

/** Keyed card entry via Stripe Elements. Card data goes straight to Stripe; we only receive a PaymentMethod id. */
export function StripeCardEntry({ publishableKey, amountCents, onPaymentMethod }: { publishableKey: string; amountCents: number; onPaymentMethod: (id: string) => void }) {
  const stripe = useMemo(() => getStripe(publishableKey), [publishableKey]);
  return (
    <Elements
      stripe={stripe}
      options={{ mode: "payment", amount: Math.max(50, amountCents), currency: "usd", paymentMethodTypes: ["card"], paymentMethodCreation: "manual", appearance: { theme: "stripe" } }}
    >
      <Inner amountCents={amountCents} onPaymentMethod={onPaymentMethod} />
    </Elements>
  );
}

function Inner({ amountCents, onPaymentMethod }: { amountCents: number; onPaymentMethod: (id: string) => void }) {
  const stripe = useStripe();
  const elements = useElements();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    elements?.update({ amount: Math.max(50, amountCents) });
  }, [elements, amountCents]);
  return (
    <div className="space-y-3">
      <PaymentElement options={{ layout: "tabs", wallets: { applePay: "never", googlePay: "never" } }} />
      {error && <Notice tone="red">{error}</Notice>}
      <Button
        variant="dark"
        className="w-full"
        disabled={!stripe || !elements || busy}
        onClick={async () => {
          if (!stripe || !elements) return;
          setBusy(true);
          setError(null);
          const submitted = await elements.submit();
          if (submitted.error) {
            setError(submitted.error.message ?? "Check the card details");
            setBusy(false);
            return;
          }
          const { error: err, paymentMethod } = await stripe.createPaymentMethod({ elements });
          setBusy(false);
          if (err || !paymentMethod) return setError(err?.message ?? "Card couldn't be read");
          onPaymentMethod(paymentMethod.id);
        }}
      >
        {busy ? "Checking card…" : "Use this card"}
      </Button>
    </div>
  );
}
