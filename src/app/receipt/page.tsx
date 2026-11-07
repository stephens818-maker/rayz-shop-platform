import type { Metadata } from "next";
import { RequestForm } from "./request-form";

export const metadata: Metadata = { title: "Get a copy of your receipt", robots: { index: false } };

/** A client asking for their recent receipts again, sent only to the number or email the shop has for them. */
export default function RequestReceiptPage() {
  return (
    <div className="min-h-dvh bg-zinc-100" style={{ borderTop: "6px solid #111318" }}>
      <main className="mx-auto max-w-md px-4 pb-10 pt-8">
        <div className="space-y-4 rounded-2xl bg-white p-6 shadow-sm ring-1 ring-zinc-200">
          <div>
            <h1 className="text-xl font-bold">Get a copy of your receipt</h1>
            <p className="mt-1 text-sm text-zinc-600">Enter the mobile number or email you gave the shop. We&apos;ll send links to your last few receipts there.</p>
          </div>
          <RequestForm />
        </div>
      </main>
    </div>
  );
}
