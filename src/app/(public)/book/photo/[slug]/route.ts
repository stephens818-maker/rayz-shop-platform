import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { staff, staffPhotos, staffShops } from "@/db/schema";

/** A bookable barber's photo for the public booking page. Other staff photos stay private. */
export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const [row] = await db
    .select({ dataUrl: staffPhotos.dataUrl })
    .from(staffPhotos)
    .innerJoin(staff, eq(staff.id, staffPhotos.staffId))
    .innerJoin(staffShops, eq(staffShops.staffId, staff.id))
    .where(and(eq(staff.publicSlug, slug), eq(staff.active, true), eq(staff.isBookable, true), eq(staffShops.visibleOnline, true)));
  const m = row && /^data:(image\/(?:jpeg|png|webp));base64,(.*)$/.exec(row.dataUrl);
  if (!m) return new Response("Not found", { status: 404 });
  return new Response(Buffer.from(m[2], "base64"), {
    headers: { "Content-Type": m[1], "Cache-Control": "public, max-age=3600", "X-Content-Type-Options": "nosniff" },
  });
}
