import type { Metadata } from "next";
import { stripePayoutsOn } from "@/server/tips/payout-model";

export const metadata: Metadata = { title: "Set up your Ray'z tip payouts", robots: { index: false } };

/**
 * Where payout setup invites and reminders point. It carries nothing and reads nothing: it opens the
 * Ray'z Staff app on its banking screen, or My banking on the web, both behind sign-in.
 */
export default function Page() {
  if (!stripePayoutsOn())
    return (
      <main className="mx-auto max-w-md px-4 py-16">
        <div className="rounded-xl bg-white p-6 ring-1 ring-zinc-200">
          <h1 className="text-xl font-bold">Your tips are paid through payroll</h1>
          <p className="mt-2 text-sm text-zinc-600">There&rsquo;s nothing to set up: your tips come with your paycheck. Pay stubs and W-2s are in iSolved employee self-service.</p>
        </div>
      </main>
    );
  const scheme = process.env.STAFF_APP_SCHEME?.trim() || "rayzstaff";
  return (
    <main className="mx-auto max-w-md px-4 py-16">
      <div className="rounded-xl bg-white p-6 ring-1 ring-zinc-200">
        <h1 className="text-xl font-bold">Set up your Ray&rsquo;z tip payouts</h1>
        <p className="mt-2 text-sm text-zinc-600">
          Everyone sets up a new Stripe payout account under Ray&rsquo;z, even if you had one with Squire. It takes about 5 minutes: your ID, the bank account for standard payouts,
          and a debit card if you want instant payouts. Stripe collects them on its own secure page; Ray&rsquo;z never sees your bank or card numbers.
        </p>
        <p className="mt-2 text-sm text-zinc-600">Tips approved for you before you finish wait for you, and go out on their own as soon as you&rsquo;re done.</p>
        <div className="mt-4 flex flex-wrap gap-2">
          <a className="inline-block rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white" href={`${scheme}://banking`}>
            Open the Ray&rsquo;z Staff app
          </a>
          <a className="inline-block rounded-lg px-4 py-2 text-sm font-medium text-zinc-900 ring-1 ring-zinc-300" href="/admin/my-banking">
            Set up on the web
          </a>
        </div>
      </div>
    </main>
  );
}
