import { NextResponse } from "next/server";
import { appleAppSiteAssociation } from "@/server/app-config";
import { withStaffAppleLinks } from "@/server/staff-app-links";

export const dynamic = "force-dynamic";

export function GET() {
  const doc = withStaffAppleLinks(appleAppSiteAssociation());
  return doc ? NextResponse.json(doc, { headers: { "Cache-Control": "public, max-age=3600" } }) : new NextResponse("Not configured", { status: 404 });
}
