import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { staff, staffShops } from "@/db/schema";
import { Empty, Notice, PageHeader } from "@/components/ui";
import { can, guardPage } from "@/server/auth/staff";
import { breakReasons } from "@/server/block-reasons";
import { pairedDevice } from "@/server/clock-pairing";
import { DEVICE_COOKIE, deviceFromToken, shopClocks } from "@/server/time-clock";
import { ClockQr, Kiosk } from "../clock";

export const metadata: Metadata = { title: "Front-desk clock" };

export default async function KioskPage() {
  const ctx = await guardPage("/admin/clock/kiosk");
  const device = await deviceFromToken((await cookies()).get(DEVICE_COOKIE)?.value);
  if (device && (await pairedDevice((await cookies()).get(DEVICE_COOKIE)?.value, null))) redirect("/clock");
  if (!device || !ctx.shopIds.includes(device.shopId)) {
    return (
      <div className="mx-auto max-w-xl space-y-4">
        <PageHeader title="Front-desk clock" subtitle="A shared device at the front desk where staff clock in and out with their own PIN." />
        {device && <Notice tone="red">This device is registered to {device.shop}, which is outside your access.</Notice>}
        <Empty title="This browser isn't the front-desk clock">
          This phone can&apos;t clock you in by itself. Use the paired clock at the desk and your PIN, or scan the QR code on that clock.
        </Empty>
      </div>
    );
  }
  if (!can(ctx, "timeclock.kiosk")) return <Empty title="You can't open the front-desk clock">Ask a manager for the front-desk clock permission.</Empty>;
  const [[clock], people, reasons] = await Promise.all([
    shopClocks([device.shopId]),
    db
      .select({ id: staff.id, label: staff.displayLabel, pin: staff.clockPinHash })
      .from(staffShops)
      .innerJoin(staff, eq(staff.id, staffShops.staffId))
      .where(and(eq(staffShops.shopId, device.shopId), eq(staff.active, true), eq(staff.kind, "person")))
      .orderBy(asc(staff.displayLabel)),
    breakReasons(device.shopId),
  ]);
  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <PageHeader title={`${device.shop} time clock`} subtitle={`${device.label}. Tap your name, type your PIN, punch.`} />
      {people.length ? (
        <Kiosk shop={device.shop} people={people.map((p) => ({ id: p.id, label: p.label, hasPin: !!p.pin }))} photo={clock?.settings.photo ?? "off"} breakReasons={reasons} />
      ) : (
        <Empty title="Nobody is on this shop's team yet" />
      )}
      <ClockQr />
    </div>
  );
}
