import type { Metadata } from "next";
import Link from "next/link";
import { Empty, Notice, PageHeader } from "@/components/ui";
import { guardPage } from "@/server/auth/staff";
import { listOpenings, mayApproveOpenings, mayConfigureOpenings, mayOpenings, openingsSetup, openingsShops } from "@/server/marketing/openings";
import { OpeningsComposer } from "./composer";
import { OpeningsApprovals, OpeningsHistory } from "./history";

export const metadata: Metadata = { title: "We have openings" };
export const dynamic = "force-dynamic";

export default async function OpeningsPage({ searchParams }: { searchParams: Promise<{ shop?: string }> }) {
  const ctx = await guardPage("/admin/campaign-center/openings");
  const sp = await searchParams;
  const canSend = mayOpenings(ctx);
  const shops = openingsShops(ctx);
  const shopId = !canSend ? null : (shops.find((s) => s.id === sp.shop) ?? shops.find((s) => s.id === ctx.currentShopId) ?? shops[0])?.id;
  const [setup, recent, waiting] = await Promise.all([
    shopId ? openingsSetup(ctx, shopId) : null,
    listOpenings(ctx, shopId ? { shopIds: [shopId] } : {}),
    mayApproveOpenings(ctx) ? listOpenings(ctx, { status: "pending_approval" }) : [],
  ]);
  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <PageHeader
        title="We have openings"
        subtitle={
          <>
            Tell a barber&apos;s regulars and recent clients they have open times, first come, first served. The link shows the barber&apos;s live times, which disappear as they&apos;re booked.
            {mayConfigureOpenings(ctx) && (
              <>
                {" "}
                <Link href="/admin/campaign-center/settings#openings" className="underline">
                  Openings rules
                </Link>
              </>
            )}
          </>
        }
        actions={
          canSend && shops.length > 1 ? (
            <form className="flex items-center gap-2 text-sm">
              <label htmlFor="shop" className="text-zinc-500">
                Location
              </label>
              <select id="shop" name="shop" defaultValue={shopId ?? ""} className="rounded-lg px-2 py-1.5 ring-1 ring-zinc-300">
                {shops.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
              <button className="rounded-lg bg-zinc-900 px-3 py-1.5 text-white">Go</button>
            </form>
          ) : null
        }
      />
      {waiting.length > 0 && <OpeningsApprovals blasts={waiting} />}
      {canSend && !shops.length && <Empty title="None of your locations is open for bookings" />}
      {!canSend && <Notice tone="blue">You approve locations&apos; openings blasts here. Sending them needs Campaign Center: We have openings.</Notice>}
      {setup && <OpeningsComposer key={setup.shop.id} setup={setup} />}
      <OpeningsHistory blasts={recent} showShop={!shopId} canSend={canSend} />
    </div>
  );
}
