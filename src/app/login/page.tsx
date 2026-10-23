import type { Metadata } from "next";
import Link from "next/link";
import { Logo } from "@/components/ui";
import { demoMode } from "@/lib/deployment";
import { DemoLogin, LoginForm } from "./form";

export const metadata: Metadata = { title: "Staff sign in" };

const DEMO_LOGINS: DemoLogin[] = [
  { email: "owner@rayz.test", who: "Brand owner", sees: "every shop, every report and setting" },
  { email: "coralville@rayz.test", who: "Coralville shop login", sees: "the front desk for one shop" },
  { email: "michelle@rayz.test", who: "Michelle, shop manager", sees: "Coralville's tools and reports" },
  { email: "makenna@rayz.test", who: "Makenna, barber", sees: "her own column, clients and sales" },
];

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  const showDemo = demoMode() || process.env.NODE_ENV !== "production" || process.env.SHOW_DEMO_LOGINS === "true";
  return (
    <div className="grid min-h-dvh place-items-center bg-ink-900 px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex justify-center">
          <Link href="/">
            <Logo dark />
          </Link>
        </div>
        <div className="rounded-2xl bg-white p-6 shadow-xl">
          <h1 className="text-lg font-semibold">Staff sign in</h1>
          <p className="mt-1 text-sm text-zinc-500">Owners, managers and barbers.</p>
          <LoginForm next={next ?? ""} demo={showDemo ? { password: process.env.SEED_PASSWORD ? null : "rayz2026!", logins: DEMO_LOGINS } : undefined} />
        </div>
      </div>
    </div>
  );
}
