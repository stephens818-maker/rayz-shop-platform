"use client";

import { useRouter } from "next/navigation";
import { useAction } from "@/components/use-action";
import { cx } from "@/components/ui";
import type { DeskStep } from "@/domain/front-desk";
import { setStatusAction, startCheckoutAction } from "./calendar/actions";

/** One of today's clients at the desk, with its one next step as a large button. */
export function DeskClientRow(p: { id: string; time: string; late: boolean; client: string; barber: string; services: string | null; status: string; step: DeskStep }) {
  const router = useRouter();
  const { pending, error, run } = useAction();
  const toCheckout = () =>
    run(
      () => startCheckoutAction(p.id),
      (d) => router.push(`/admin/checkout/${d.saleId}`),
    );
  return (
    <li className="flex flex-wrap items-center gap-3 px-4 py-3" data-testid="front-desk-client">
      <div className={cx("w-20 shrink-0 tabular text-base font-semibold", p.late && "text-amber-700")}>{p.time}</div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-base font-semibold">{p.client}</div>
        <div className="truncate text-sm text-zinc-600">
          {p.barber}
          {p.services ? ` · ${p.services}` : ""} · {p.status}
        </div>
        {error && <div className="mt-1 text-sm text-red-700">{error}</div>}
      </div>
      {p.step === "check_in" && (
        <button
          disabled={pending}
          onClick={() => run(() => setStatusAction(p.id, "checked_in"), undefined, `${p.client} is checked in`)}
          className="h-14 min-w-36 rounded-xl bg-white px-5 text-base font-semibold text-zinc-900 ring-1 ring-zinc-300 hover:bg-zinc-50 disabled:opacity-50"
        >
          Check in
        </button>
      )}
      {p.step === "check_out" && (
        <button disabled={pending} onClick={toCheckout} className="h-14 min-w-36 rounded-xl bg-brand-600 px-5 text-base font-semibold text-white hover:bg-brand-700 disabled:opacity-50">
          Check out
        </button>
      )}
    </li>
  );
}
