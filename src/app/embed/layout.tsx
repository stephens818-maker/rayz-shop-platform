import type { Metadata } from "next";
import Link from "next/link";
import { EmbedFrame } from "./frame";

export const metadata: Metadata = { robots: { index: false } };

/** The booking widget's frame: the booking flow without the site's header and footer. */
export default function EmbedLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-zinc-50 px-3 py-4 sm:px-4">
      <EmbedFrame />
      {children}
      <p className="mt-6 text-center text-[11px] text-zinc-400">
        Booking by{" "}
        <Link href="/" target="_top" className="underline">
          Ray&apos;z Barber Shop
        </Link>
      </p>
    </div>
  );
}
