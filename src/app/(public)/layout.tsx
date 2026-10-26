import Link from "next/link";
import { Logo } from "@/components/ui";

export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-dvh bg-zinc-50">
      <header className="sticky top-0 z-20 border-b border-white/10 bg-ink-900">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-4">
          <Link href="/">
            <Logo dark />
          </Link>
          <nav className="flex items-center gap-1 text-sm">
            <Link href="/locations" className="rounded-md px-3 py-1.5 text-zinc-300 hover:bg-white/10 hover:text-white">
              Locations
            </Link>
            <Link href="/account" className="rounded-md px-3 py-1.5 text-zinc-300 hover:bg-white/10 hover:text-white">
              My visits
            </Link>
            <Link href="/" className="rounded-md bg-brand-600 px-3 py-1.5 font-medium text-white hover:bg-brand-700">
              Book
            </Link>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 pb-24 pt-6">{children}</main>
      <footer className="border-t border-zinc-200 py-6 text-center text-xs text-zinc-500">
        Ray&apos;z Barber Shop · modern meets retro ·{" "}
        <Link href="/receipt" className="underline">
          Receipts
        </Link>{" "}
        ·{" "}
        <Link href="/login" className="underline">
          Staff
        </Link>{" "}
        ·{" "}
        <Link href="/docs/api" className="underline">
          API
        </Link>{" "}
        ·{" "}
        <Link href="/support" className="underline">
          Support
        </Link>{" "}
        ·{" "}
        <Link href="/privacy" className="underline">
          Privacy
        </Link>{" "}
        ·{" "}
        <Link href="/terms" className="underline">
          Terms
        </Link>
      </footer>
    </div>
  );
}
