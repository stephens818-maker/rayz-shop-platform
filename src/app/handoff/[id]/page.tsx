import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
import Link from "next/link";
import { HANDOFF_COOKIE } from "@/server/auth/cookies";
import { handoffIdFrom } from "@/server/auth/handoff-lock";
import { handoffView } from "@/server/handoff";
import { CustomerScreen } from "./customer-screen";

export const metadata: Metadata = { title: "Checkout", robots: { index: false } };
export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover", themeColor: "#ffffff" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function HandoffPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const jar = await cookies();
  const mine = UUID.test(id) && (await handoffIdFrom(jar.get(HANDOFF_COOKIE)?.value)) === id;
  if (!mine) {
    return (
      <main className="grid min-h-dvh place-items-center bg-white p-6 text-center">
        <div className="max-w-sm space-y-3">
          <h1 className="text-xl font-semibold">This customer screen isn&apos;t open on this device</h1>
          <p className="text-sm text-zinc-600">A ticket is handed to a client from checkout on the device they&apos;ll use.</p>
          <Link className="inline-block text-sm font-medium underline" href="/admin">
            Go to staff screens
          </Link>
        </div>
      </main>
    );
  }
  return <CustomerScreen initial={await handoffView(id)} />;
}
