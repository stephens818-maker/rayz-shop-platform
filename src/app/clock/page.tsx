import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { staff, staffShops } from "@/db/schema";
import { Empty, PageHeader } from "@/components/ui";
import { ClockQr, Kiosk } from "@/app/admin/clock/clock";
import { breakReasons } from "@/server/block-reasons";
import { pairedDevice } from "@/server/clock-pairing";
import { DEVICE_COOKIE, shopClocks } from "@/server/time-clock";

export const metadata: Metadata = { title: "Front-desk clock", robots: { index: false } };
export const dynamic = "force-dynamic";

/** A paired front-desk clock (ST-C0c): no staff session, each punch by the person's own PIN. */
export default async function PairedClockPage() {
  const device = await pairedDevice((await cookies()).get(DEVICE_COOKIE)?.value, null);
  if (!device)
    return (
      <main className="mx-auto max-w-md p-6">
        <Empty title="This device isn't a front-desk clock">
          Ask a manager to pair it: they make a one-time code in Time clock setup.{" "}
          <Link href="/clock/pair" className="underline">
            Pair this device
          </Link>
        </Empty>
      </main>
    );
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
    <main className="mx-auto max-w-2xl space-y-4 p-4">
      <PageHeader title={`${device.shop} time clock`} subtitle={`${device.label}. Tap your name, type your PIN, punch.`} />
      {people.length ? (
        <Kiosk shop={device.shop} people={people.map((p) => ({ id: p.id, label: p.label, hasPin: !!p.pin }))} photo={clock?.settings.photo ?? "off"} breakReasons={reasons} />
      ) : (
        <Empty title="Nobody is on this shop's team yet" />
      )}
      {clock?.settings.methods.includes("qr") && <ClockQr />}
    </main>
  );
}
