import Link from "next/link";
import { Empty } from "@/components/ui";
import type { StaffContext } from "@/server/auth/staff";

/** A one-shop page when the brand view is on every shop. Links keep ?shop= so nothing falls back to the first shop. */
export function ShopRequired({ ctx, base }: { ctx: StaffContext; base: string }) {
  const shops = ctx.assignedShops.filter((s) => s.status !== "archived");
  return (
    <Empty title="Pick a shop">
      <p>This page is for one shop. Every shop is listed. Nothing is selected until you pick one.</p>
      <div className="mt-3 flex flex-wrap justify-center gap-2">
        {shops.map((s) => (
          <Link key={s.id} href={`${base}?shop=${s.id}`} className="rounded-full bg-white px-3 py-1 text-sm text-zinc-800 ring-1 ring-zinc-300 hover:bg-zinc-50">
            {s.name}
          </Link>
        ))}
      </div>
    </Empty>
  );
}
