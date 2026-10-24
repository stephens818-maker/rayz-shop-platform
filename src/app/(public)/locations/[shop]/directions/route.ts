import { NextResponse } from "next/server";
import { publicLocation } from "@/server/public-locations";

/** A short, stable directions link for texts and emails: on to Google Maps for wherever the shop is now. */
export async function GET(req: Request, { params }: { params: Promise<{ shop: string }> }) {
  const { shop } = await params;
  const l = await publicLocation(shop, { nextSlot: false }).catch(() => null);
  if (!l) return NextResponse.redirect(new URL("/locations", req.url), 302);
  return NextResponse.redirect(l.links.directions, 302);
}
