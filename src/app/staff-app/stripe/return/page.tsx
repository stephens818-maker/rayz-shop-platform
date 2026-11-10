import type { Metadata } from "next";
import { StripeHandoff } from "../handoff";

export const metadata: Metadata = { title: "Back to the Ray'z Staff app", robots: { index: false } };

export default async function Page({ searchParams }: { searchParams: Promise<{ from?: string }> }) {
  return <StripeHandoff kind="return" from={(await searchParams).from} />;
}
