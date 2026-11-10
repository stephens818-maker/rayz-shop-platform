import type { Metadata } from "next";
import { StripeHandoff } from "./handoff";

export const metadata: Metadata = { title: "Back to the Ray'z Staff app", robots: { index: false } };

/** Links Stripe made before the return and refresh pages: the same handoff. */
export default async function Page({ searchParams }: { searchParams: Promise<{ stripe?: string }> }) {
  return <StripeHandoff kind={(await searchParams).stripe === "refresh" ? "refresh" : "return"} />;
}
