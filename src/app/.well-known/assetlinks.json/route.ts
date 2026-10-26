import { NextResponse } from "next/server";
import { androidAssetLinks } from "@/server/app-config";

export const dynamic = "force-dynamic";

export function GET() {
  const doc = androidAssetLinks();
  return doc ? NextResponse.json(doc, { headers: { "Cache-Control": "public, max-age=3600" } }) : new NextResponse("Not configured", { status: 404 });
}
