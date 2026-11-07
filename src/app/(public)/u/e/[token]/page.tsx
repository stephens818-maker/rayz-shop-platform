import type { Metadata } from "next";
import { maskEmail } from "@/domain/client-privacy";
import { unsubscribeTarget } from "@/server/notifications/email-events";
import { stopEmailsAction } from "./actions";

export const metadata: Metadata = { title: "Stop emails", robots: { index: false } };
export const dynamic = "force-dynamic";

/** The stop link at the bottom of every email to a client: confirm, and no email goes to that address again. */
export default async function StopEmailsPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const t = await unsubscribeTarget(token);
  return (
    <div className="mx-auto max-w-md space-y-3 rounded-xl bg-white p-6 text-center ring-1 ring-zinc-200">
      {!t ? (
        <>
          <h1 className="text-xl font-bold">This link doesn&apos;t work</h1>
          <p className="text-zinc-600">Check that you opened the whole link from the email, or call the shop and we&apos;ll stop them for you.</p>
        </>
      ) : t.stopped ? (
        <>
          <h1 className="text-xl font-bold">Emails stopped</h1>
          <p className="text-zinc-600">
            We won&apos;t email <span className="font-medium">{maskEmail(t.email)}</span> again: no reminders, receipts or offers. Texts you agreed to still come. To get emails again, ask the shop.
          </p>
        </>
      ) : (
        <>
          <h1 className="text-xl font-bold">Stop emails from Ray&apos;z?</h1>
          <p className="text-zinc-600">
            No more emails to <span className="font-medium">{maskEmail(t.email)}</span>: appointment confirmations, reminders, receipts and offers. Texts you agreed to still come.
          </p>
          <form action={stopEmailsAction.bind(null, token)}>
            <button type="submit" className="inline-flex h-10 items-center rounded-lg bg-brand-600 px-4 text-sm font-medium text-white">
              Stop emails
            </button>
          </form>
        </>
      )}
    </div>
  );
}
