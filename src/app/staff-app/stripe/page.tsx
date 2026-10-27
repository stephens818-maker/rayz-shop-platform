import type { Metadata } from "next";
import { stripePayoutsOn } from "@/server/tips/payout-model";

export const metadata: Metadata = { title: "Back to the Ray'z Staff app", robots: { index: false } };

/**
 * Where Stripe's hosted payout setup sends the staff app's browser when it's done (or the link ran
 * out). Nothing is read or changed here; the app refreshes its banking status when it comes back.
 */
export default async function Page({ searchParams }: { searchParams: Promise<{ stripe?: string }> }) {
  const sp = await searchParams;
  if (!stripePayoutsOn())
    return (
      <main className="mx-auto max-w-md px-4 py-16">
        <div className="rounded-xl bg-white p-6 ring-1 ring-zinc-200">
          <h1 className="text-xl font-bold">Your tips are paid through payroll</h1>
          <p className="mt-2 text-sm text-zinc-600">There&rsquo;s nothing to set up: your tips come with your paycheck. Pay stubs and W-2s are in iSolved employee self-service.</p>
        </div>
      </main>
    );
  const expired = sp.stripe === "refresh";
  const scheme = process.env.STAFF_APP_SCHEME?.trim() || "rayzstaff";
  return (
    <main className="mx-auto max-w-md px-4 py-16">
      <div className="rounded-xl bg-white p-6 ring-1 ring-zinc-200">
        <h1 className="text-xl font-bold">{expired ? "That link ran out" : "You're done with Stripe"}</h1>
        <p className="mt-2 text-sm text-zinc-600">
          {expired ? "Go back to the Ray'z Staff app and tap Set up payouts again for a fresh link." : "Go back to the Ray'z Staff app. Your payout status updates there in a moment."}
        </p>
        <a className="mt-4 inline-block rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white" href={`${scheme}://banking${expired ? "?stripe=refresh" : "?stripe=return"}`}>
          Open the app
        </a>
      </div>
    </main>
  );
}
