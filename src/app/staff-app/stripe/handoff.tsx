import { stripePayoutsOn } from "@/server/tips/payout-model";

/**
 * Where Stripe's hosted payout setup comes back to (ST-I15): HTTPS pages the staff app opens itself
 * as universal links and App Links, so the app picks up right where Stripe left off. Opened in a
 * browser instead, they hand over to the app, or to My banking for setup started on the web. Nothing
 * is read or changed here; the app (or My banking) refreshes the banking status when it comes back.
 */
export function StripeHandoff({ kind, from }: { kind: "return" | "refresh"; from?: string }) {
  if (!stripePayoutsOn())
    return (
      <main className="mx-auto max-w-md px-4 py-16">
        <div className="rounded-xl bg-white p-6 ring-1 ring-zinc-200">
          <h1 className="text-xl font-bold">Your tips are paid through payroll</h1>
          <p className="mt-2 text-sm text-zinc-600">There&rsquo;s nothing to set up: your tips come with your paycheck. Pay stubs and W-2s are in iSolved employee self-service.</p>
        </div>
      </main>
    );
  const expired = kind === "refresh";
  const web = from === "web";
  const scheme = process.env.STAFF_APP_SCHEME?.trim() || "rayzstaff";
  const href = web ? `/admin/my-banking?stripe=${kind}` : `${scheme}://banking?stripe=${kind}`;
  return (
    <main className="mx-auto max-w-md px-4 py-16">
      <div className="rounded-xl bg-white p-6 ring-1 ring-zinc-200">
        <h1 className="text-xl font-bold">{expired ? "That link ran out" : "You're done with Stripe"}</h1>
        <p className="mt-2 text-sm text-zinc-600">
          {expired
            ? `Stripe's setup links only last a few minutes. Go back to ${web ? "My banking" : "the Ray'z Staff app"} and tap Set up payouts again for a fresh one; what you already entered is saved.`
            : `Go back to ${web ? "My banking" : "the Ray'z Staff app"}. Your payout status updates there in a moment.`}
        </p>
        <a className="mt-4 inline-block rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white" href={href}>
          {web ? "Back to My banking" : "Open the app"}
        </a>
        {!web && (
          <p className="mt-3 text-xs text-zinc-500">
            Set up on the web instead? <a className="underline" href={`/admin/my-banking?stripe=${kind}`}>My banking</a>
          </p>
        )}
      </div>
    </main>
  );
}
