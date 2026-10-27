import type { Metadata } from "next";
import { Card, CardHeader } from "@/components/ui";
import { normalizeCode } from "@/server/clock-pairing";
import { PairForm } from "./pair-form";

export const metadata: Metadata = { title: "Pair a front-desk clock", robots: { index: false } };

export default async function PairPage({ searchParams }: { searchParams: Promise<{ code?: string }> }) {
  const { code } = await searchParams;
  return (
    <main className="mx-auto max-w-md p-6">
      <Card>
        <CardHeader
          title="Pair a front-desk clock"
          subtitle="A manager makes a one-time code in Time clock setup. Scan its QR code with this device's camera, or type the code. No one signs in on this device; staff punch with their own PIN."
        />
        <div className="p-4 pt-0">
          <PairForm initialCode={(code && normalizeCode(code)) ?? ""} />
        </div>
      </Card>
    </main>
  );
}
