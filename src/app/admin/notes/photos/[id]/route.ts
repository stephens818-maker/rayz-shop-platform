import { routeStaff } from "@/server/auth/staff";
import { notePhoto } from "@/server/client-notes";

/** A cut note's before or after photo, for whoever may read the note. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await routeStaff("notes.view");
  if (ctx instanceof Response) return ctx;
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new Response("Not found", { status: 404 });
  const url = await notePhoto(ctx, id);
  const m = url && /^data:(image\/(?:jpeg|png|webp));base64,(.*)$/.exec(url);
  if (!m) return new Response("Not found", { status: 404 });
  return new Response(Buffer.from(m[2], "base64"), { headers: { "Content-Type": m[1], "Cache-Control": "private, max-age=300", "X-Content-Type-Options": "nosniff" } });
}
