import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { customers, marketingCampaigns, marketingSends, shops } from "@/db/schema";
import { audit } from "@/server/audit";
import { isSteppedUp, stepUpRedirect } from "@/server/auth/sessions";
import { routeStaff } from "@/server/auth/staff";
import { clientListDenied, clientPolicy, recordClientAccess } from "@/server/client-privacy";
import { guardian, householdContact } from "@/server/household-contact";
import { contactsFor } from "@/server/marketing/consent";
import { toCsv } from "@/server/reports";

const MAX_ROWS = 50_000;

/**
 * Campaign Center contacts as a CSV: who has agreed to marketing on each channel, or who one campaign
 * went to (?campaign=<id>). Only for "Campaign Center: export" (brand-level, off for every role until
 * the Brand Owner grants it); everyone else sees counts. Phone and email are exported as the exporter
 * sees them, and every export is audited with the clients it contained.
 */
export async function GET(req: Request) {
  const ctx = await routeStaff("campaign_center.export");
  if (ctx instanceof Response) return ctx;
  if (!(await isSteppedUp(ctx))) return stepUpRedirect(req, "export");
  const refused = clientListDenied(ctx);
  if (refused) return new Response(refused, { status: 403 });
  const campaignId = new URL(req.url).searchParams.get("campaign");
  const policy = await clientPolicy(ctx);
  const scoped = ctx.brandWide ? undefined : sql`coalesce((select a.shop_id from appointments a where a.customer_id = ${customers.id} and a.status = 'completed' order by a.starts_at desc limit 1), ${customers.homeShopId}) in (${sql.join(
    (ctx.shopIds.length ? ctx.shopIds : ["00000000-0000-0000-0000-000000000000"]).map((s) => sql`${s}::uuid`),
    sql`, `,
  )})`;

  let campaign: { id: string; name: string } | null = null;
  let sent = new Map<string, { channel: string | null; at: Date; clicks: number }>();
  let ids: string[];
  if (campaignId) {
    if (!/^[0-9a-f-]{36}$/i.test(campaignId)) return new Response("Unknown campaign", { status: 404 });
    const [c] = await db.select({ id: marketingCampaigns.id, name: marketingCampaigns.name }).from(marketingCampaigns).where(eq(marketingCampaigns.id, campaignId));
    if (!c) return new Response("Unknown campaign", { status: 404 });
    campaign = c;
    const rows = await db
      .select({ customerId: marketingSends.customerId, channel: marketingSends.channel, at: marketingSends.createdAt, clicks: marketingSends.clicks })
      .from(marketingSends)
      .where(and(eq(marketingSends.campaignId, c.id), eq(marketingSends.status, "queued"), ctx.brandWide ? undefined : inArray(marketingSends.shopId, ctx.shopIds.length ? ctx.shopIds : ["00000000-0000-0000-0000-000000000000"])))
      .limit(MAX_ROWS);
    sent = new Map(rows.filter((r) => r.customerId).map((r) => [r.customerId!, { channel: r.channel, at: r.at, clicks: r.clicks }]));
    ids = [...sent.keys()];
  } else {
    ids = (await db.select({ id: customers.id }).from(customers).where(scoped).limit(MAX_ROWS)).map((r) => r.id);
  }
  const contacts = await contactsFor(ids);
  const keep = campaign ? ids : ids.filter((id) => {
    const r = contacts.get(id)?.reach;
    return r && (r.sms || r.email || r.push);
  });
  const people = keep.length
    ? await db
        .select({ id: customers.id, firstName: customers.firstName, lastName: customers.lastName, phone: householdContact.phone, email: householdContact.email, shop: shops.name })
        .from(customers)
        .leftJoin(guardian, eq(guardian.id, customers.guardianId))
        .leftJoin(shops, eq(shops.id, customers.homeShopId))
        .where(inArray(customers.id, keep))
    : [];
  const showPhone = policy.level("phone") !== "hidden";
  const showEmail = policy.level("email") !== "hidden";
  const yes = (b: boolean | undefined) => (b ? "yes" : "no");
  const headers = [
    "First name",
    "Last name",
    ...(showPhone ? ["Phone"] : []),
    ...(showEmail ? ["Email"] : []),
    "Marketing texts",
    "Marketing emails",
    "App push",
    "Home shop",
    ...(campaign ? ["Sent by", "Sent", "Clicks"] : []),
  ];
  const data = people
    .sort((a, b) => (a.lastName ?? "").localeCompare(b.lastName ?? "") || a.firstName.localeCompare(b.firstName))
    .map((p) => {
      const r = contacts.get(p.id)?.reach;
      const s = sent.get(p.id);
      return [
        p.firstName,
        p.lastName,
        ...(showPhone ? [policy.show("phone", p.phone)] : []),
        ...(showEmail ? [policy.show("email", p.email)] : []),
        yes(r?.sms),
        yes(r?.email),
        yes(r?.push),
        p.shop,
        ...(campaign ? [s?.channel ?? "", s?.at.toISOString().slice(0, 10) ?? "", s?.clicks ?? 0] : []),
      ];
    });
  const fields = [...(showPhone ? [`phone:${policy.level("phone")}`] : []), ...(showEmail ? [`email:${policy.level("email")}`] : [])];
  const detail = { export: "marketing_contacts", campaignId: campaign?.id ?? null, clients: people.length, fields };
  await recordClientAccess(ctx, { kind: "export", detail });
  await audit(ctx.actor, "campaign_center.export", "customer", null, { ...detail, customerIds: people.map((p) => p.id) }, ctx.currentShopId);
  const name = `rayz-campaign-center-${campaign ? "campaign" : "contacts"}-${new Date().toISOString().slice(0, 10)}.csv`;
  return new Response(toCsv(headers, data), {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${name}"`, "Cache-Control": "no-store" },
  });
}
