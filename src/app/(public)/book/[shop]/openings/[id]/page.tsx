import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { liveOpenings } from "@/server/marketing/openings";
import { LiveOpeningsView } from "./live";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ shop: string; id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const live = await liveOpenings(id).catch(() => null);
  return { title: live ? `${live.barber.firstName} has openings at ${live.shop.name}` : "Openings", robots: { index: false } };
}

export default async function OpeningsLivePage({ params }: { params: Promise<{ shop: string; id: string }> }) {
  const { shop, id } = await params;
  const live = await liveOpenings(id);
  if (!live || live.shop.slug !== shop) {
    if (!live) notFound();
    return (
      <p className="text-center">
        <Link href={`/book/${live.shop.slug}/openings/${live.id}`} className="underline">
          See {live.barber.firstName}&apos;s openings
        </Link>
      </p>
    );
  }
  return <LiveOpeningsView initial={live} />;
}
