import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { clientPhotos, customers } from "@/db/schema";
import { routeStaff } from "@/server/auth/staff";
import { clientPolicy } from "@/server/client-privacy";
import { photoReach } from "@/server/client-search";

/** A client's photo, for people who see photos and can reach the client (see photoReach). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await routeStaff(null);
  if (ctx instanceof Response) return ctx;
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new Response("Not found", { status: 404 });
  if ((await clientPolicy(ctx)).level("photo") !== "full") return new Response("Not found", { status: 404 });
  const [row] = await db
    .select({ dataUrl: clientPhotos.dataUrl })
    .from(clientPhotos)
    .innerJoin(customers, eq(customers.id, clientPhotos.customerId))
    .where(and(eq(clientPhotos.customerId, id), photoReach(ctx)));
  const m = row && /^data:(image\/(?:jpeg|png|webp));base64,(.*)$/.exec(row.dataUrl);
  if (!m) return new Response("Not found", { status: 404 });
  return new Response(Buffer.from(m[2], "base64"), { headers: { "Content-Type": m[1], "Cache-Control": "private, max-age=300", "X-Content-Type-Options": "nosniff" } });
}
