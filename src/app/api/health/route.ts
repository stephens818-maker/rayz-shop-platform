import { sql } from "drizzle-orm";
import { db } from "@/db";
import { buildRevision } from "@/lib/deployment";

export const dynamic = "force-dynamic";

/** Database round trip and the running commit. A stuck checkout must not make this wait. */
export async function GET() {
  const started = Date.now();
  try {
    await db.execute(sql`select 1`);
    return Response.json({ ok: true, dbMs: Date.now() - started, commit: buildRevision() });
  } catch {
    return Response.json({ ok: false, dbMs: Date.now() - started, commit: buildRevision() }, { status: 503 });
  }
}
