import type { Metadata } from "next";
import { StripeHandoff } from "../handoff";

export const metadata: Metadata = { title: "Start Stripe payout setup again", robots: { index: false } };

export default async function Page({ searchParams }: { searchParams: Promise<{ from?: string }> }) {
  return <StripeHandoff kind="refresh" from={(await searchParams).from} />;
}
