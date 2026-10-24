import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { groupView, publicGroup } from "@/server/booking-groups";
import { AppError } from "@/server/errors";
import { ManageGroup } from "./group";

export const metadata: Metadata = { title: "Your family booking", robots: { index: false } };
export const dynamic = "force-dynamic";

export default async function Page({ params, searchParams }: { params: Promise<{ code: string }>; searchParams: Promise<{ new?: string }> }) {
  const { code } = await params;
  const { new: isNew } = await searchParams;
  const view = await groupView(code).catch((e) => {
    if (e instanceof AppError && e.code === "not_found") notFound();
    throw e;
  });
  return <ManageGroup group={publicGroup(view)} shop={{ address: view.shop.address, phone: view.shop.phone }} isNew={isNew === "1"} />;
}
