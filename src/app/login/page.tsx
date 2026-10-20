import type { Metadata } from "next";
import Link from "next/link";
import { Logo } from "@/components/ui";
import { LoginForm } from "./form";

export const metadata: Metadata = { title: "Staff sign in" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  const demo = process.env.NODE_ENV !== "production" || process.env.SHOW_DEMO_LOGINS === "true";
  return (
    <div className="grid min-h-dvh place-items-center bg-ink-900 px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex justify-center">
          <Link href="/">
            <Logo dark />
          </Link>
        </div>
        <div className="rounded-2xl bg-white p-6 shadow-xl">
          <h1 className="text-lg font-semibold">Staff sign in</h1>
          <p className="mt-1 text-sm text-zinc-500">Owners, managers and barbers.</p>
          <LoginForm next={next ?? ""} />
        </div>
        {demo && (
          <div className="mt-4 rounded-xl bg-white/5 p-4 text-xs text-zinc-300 ring-1 ring-white/10">
            <div className="mb-1 font-semibold text-white">Demo logins (password rayz2026!)</div>
            <div>owner@rayz.test: brand admin, all shops</div>
            <div>michelle@rayz.test: Coralville shop manager</div>
            <div>makenna@rayz.test: barber</div>
          </div>
        )}
      </div>
    </div>
  );
}
