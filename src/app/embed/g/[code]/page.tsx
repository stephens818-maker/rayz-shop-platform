import { notFound } from "next/navigation";
import { groupView, publicGroup } from "@/server/booking-groups";
import { AppError } from "@/server/errors";
import { ManageGroup } from "../../../(public)/g/[code]/group";
import { EmbedEvent } from "../../frame";

export const dynamic = "force-dynamic";
export const metadata = { title: "Your family booking" };

export default async function EmbedGroup({ params, searchParams }: { params: Promise<{ code: string }>; searchParams: Promise<{ new?: string }> }) {
  const { code } = await params;
  const { new: isNew } = await searchParams;
  const view = await groupView(code).catch((e) => {
    if (e instanceof AppError && e.code === "not_found") notFound();
    throw e;
  });
  return (
    <>
      {isNew === "1" && <EmbedEvent type="rayz:booked" location={view.shop.slug} />}
      <ManageGroup group={publicGroup(view)} shop={{ address: view.shop.address, phone: view.shop.phone, mapsUrl: view.shop.mapsUrl }} isNew={isNew === "1"} basePath="/embed" />
    </>
  );
}
