import { eq } from "drizzle-orm";
import { db } from "@/db";
import { notificationJobs } from "@/db/schema";
import { canAny, routeStaff } from "@/server/auth/staff";
import { inTenant } from "@/server/tenant";

const PO_PERMS = ["po.create", "po.approve", "po.send", "po.receive"] as const;

/** A file attached to a queued email (`?i=` is its index), for the outbox and the purchase order page. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await routeStaff(["notifications.view", "notifications.send", ...PO_PERMS]);
  if (ctx instanceof Response) return ctx;
  const { id } = await params;
  if (!(await inTenant(ctx, "notification_job", id))) return new Response("Not found", { status: 404 });
  const job = await db.query.notificationJobs.findFirst({ where: eq(notificationJobs.id, id), columns: { purchaseOrderId: true, attachments: true } });
  if (!job) return new Response("Not found", { status: 404 });
  const allowed = canAny(ctx, ["notifications.view", "notifications.send"]) || (job.purchaseOrderId !== null && canAny(ctx, PO_PERMS));
  if (!allowed) return new Response("You don't have permission to do that", { status: 403 });
  const file = (job.attachments ?? [])[Number(new URL(req.url).searchParams.get("i") ?? 0)];
  if (!file) return new Response("Not found", { status: 404 });
  return new Response(Buffer.from(file.content, "base64"), {
    headers: { "content-type": file.contentType, "content-disposition": `${file.contentType === "application/pdf" ? "inline" : "attachment"}; filename="${file.filename}"` },
  });
}
