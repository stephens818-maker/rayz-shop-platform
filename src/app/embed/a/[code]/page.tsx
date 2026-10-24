import { Suspense } from "react";
import { groupCodeOf } from "@/server/booking-groups";
import { getAppointmentByCode } from "@/server/booking";
import { ManageAppointment } from "../../../(public)/a/[code]/manage";
import { EmbedEvent } from "../../frame";

export const dynamic = "force-dynamic";
export const metadata = { title: "Your appointment" };

export default async function EmbedAppointment({ params, searchParams }: { params: Promise<{ code: string }>; searchParams: Promise<{ new?: string }> }) {
  const { code } = await params;
  const { new: isNew } = await searchParams;
  const [groupCode, appt] = await Promise.all([groupCodeOf(code), isNew === "1" ? getAppointmentByCode(code).catch(() => null) : null]);
  return (
    <>
      {appt && <EmbedEvent type="rayz:booked" location={appt.shop.slug} />}
      <Suspense>
        <ManageAppointment code={code} groupCode={groupCode} basePath="/embed" />
      </Suspense>
    </>
  );
}
