import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { unsubscribeView } from "@/server/marketing/links";
import { Confirm } from "./confirm";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Unsubscribe", robots: { index: false } };

/** The unsubscribe link in every marketing email. A button, not the link itself, so mail scanners that open links don't unsubscribe anyone. */
export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const v = await unsubscribeView(token);
  if (!v) notFound();
  return (
    <main className="mx-auto max-w-md px-4 py-16">
      <div className="rounded-xl bg-white p-6 ring-1 ring-zinc-200">
        <h1 className="text-xl font-bold">Unsubscribe from {v.shopName} offers</h1>
        <p className="mt-2 text-sm text-zinc-600">Stop marketing by {v.channelLabel} from Ray&apos;z Barber Shop. Appointment confirmations and reminders aren&apos;t affected.</p>
        <Confirm token={token} channelLabel={v.channelLabel} />
      </div>
    </main>
  );
}
