import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { and, asc, desc, eq, isNull, not, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { appointments, customerSquireIds, customers, loyaltyLedger, sales, shops, staff } from "@/db/schema";
import { Badge, Card, CardHeader, PageHeader, Stat, StarBadge, StatusBadge, Table, Td, Th } from "@/components/ui";
import { formatAverage, seesAllRatings } from "@/domain/ratings";
import { formatCents } from "@/lib/money";
import { formatDate, formatDateTime } from "@/lib/time";
import { can, guardPage, ratingViewer } from "@/server/auth/staff";
import { customerAccess, customerStats, duplicatePairs } from "@/server/customers";
import { loyaltyBalance } from "@/server/loyalty";
import { rateableVisits, ratingHistory, ratingSummary } from "@/server/ratings";
import { OTHER_BARBER, OTHER_SHOP, hasShop, inShops, inTenant } from "@/server/tenant";
import { RateVisitForm, RatingHistory, Stars } from "../ratings";
import { CustomerEditor, GrantReward, MergeInto, NotesEditor } from "./editor";

export const metadata: Metadata = { title: "Client" };

const VISITS_PAGE = 25;
const SALES_PAGE = 15;

export default async function CustomerPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ v?: string; s?: string; merged?: string; existing?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;
  const ctx = await guardPage("/admin/customers/[id]");
  const access = await customerAccess({ staffId: ctx.staff.id, viewAll: can(ctx, "clients.view_all") }, id);
  if (!access) redirect("/admin/customers");
  const full = access === "full";
  const showContact = can(ctx, "clients.contact");
  const canMerge = full && can(ctx, "clients.merge");
  const c = await db.query.customers.findFirst({ where: eq(customers.id, id) });
  if (!c) notFound();
  // A shop workspace sees the shared record (name, contact, loyalty, average rating) but only what
  // happened at its own shops.
  const scoped = !ctx.brandWide;
  const mine = scoped ? ctx.shopIds : undefined;
  const here = (col: Parameters<typeof inShops>[1]) => (scoped ? inShops(ctx, col) : undefined);
  const vPage = Math.max(1, Number(sp.v) || 1);
  const sPage = Math.max(1, Number(sp.s) || 1);

  const [stats, visits, [{ visitCount }], saleRows, [{ saleCount }], loyalty, ledger, squireIds, dupes, barberOptions] = await Promise.all([
    customerStats(id, db, new Date(), mine),
    db
      .select({
        a: appointments,
        shop: shops.name,
        barber: staff.displayLabel,
        items: sql<string>`(select string_agg(name, ' + ' order by kind, name) from appointment_items i where i.appointment_id = ${appointments.id})`,
        paid: sql<number | null>`(select s.total_cents from sales s where s.appointment_id = ${appointments.id} and s.status <> 'voided' limit 1)`,
      })
      .from(appointments)
      .innerJoin(shops, eq(shops.id, appointments.shopId))
      .innerJoin(staff, eq(staff.id, appointments.staffId))
      .where(and(eq(appointments.customerId, id), here(appointments.shopId)))
      .orderBy(desc(appointments.startsAt))
      .limit(VISITS_PAGE)
      .offset((vPage - 1) * VISITS_PAGE),
    db.select({ visitCount: sql<number>`count(*)::int` }).from(appointments).where(and(eq(appointments.customerId, id), here(appointments.shopId))),
    full
      ? db
          .select({
            s: sales,
            shop: shops.name,
            refunded: sql<number>`(select coalesce(sum(r.amount_cents), 0)::int from refunds r where r.sale_id = ${sales.id} and r.kind = 'refund')`,
          })
          .from(sales)
          .innerJoin(shops, eq(shops.id, sales.shopId))
          .where(and(eq(sales.customerId, id), sql`${sales.status} <> 'open'`, here(sales.shopId)))
          .orderBy(desc(sales.businessDate), desc(sales.createdAt))
          .limit(SALES_PAGE)
          .offset((sPage - 1) * SALES_PAGE)
      : [],
    full ? db.select({ saleCount: sql<number>`count(*)::int` }).from(sales).where(and(eq(sales.customerId, id), sql`${sales.status} <> 'open'`, here(sales.shopId))) : [{ saleCount: 0 }],
    loyaltyBalance(id),
    db
      .select({ l: loyaltyLedger })
      .from(loyaltyLedger)
      .leftJoin(sales, eq(sales.id, loyaltyLedger.saleId))
      .where(and(eq(loyaltyLedger.customerId, id), scoped ? or(isNull(loyaltyLedger.saleId), inShops(ctx, sales.shopId)) : undefined))
      .orderBy(desc(loyaltyLedger.createdAt))
      .limit(20)
      .then((rows) => rows.map((r) => r.l)),
    db.select().from(customerSquireIds).where(eq(customerSquireIds.customerId, id)).orderBy(asc(customerSquireIds.createdAt)),
    canMerge ? duplicatePairs({ forId: id, limit: 10 }) : [],
    full
      ? db
          .select({ id: staff.id, label: staff.displayLabel, active: staff.active })
          .from(staff)
          .where(
            or(
              and(eq(staff.active, true), eq(staff.isBookable, true), scoped ? sql`exists (select 1 from staff_shops ss where ss.staff_id = ${staff.id} and ${inShops(ctx, sql`ss.shop_id`)})` : undefined),
              c.preferredStaffId ? eq(staff.id, c.preferredStaffId) : undefined,
            ),
          )
          .orderBy(asc(staff.displayLabel))
      : [],
  ]);
  const [elsewhere] = scoped
    ? await db
        .select({ n: sql<number>`count(*)::int` })
        .from(appointments)
        .where(and(eq(appointments.customerId, id), eq(appointments.status, "completed"), not(inShops(ctx, appointments.shopId))))
    : [{ n: 0 }];
  // Barbers who don't work at one of the viewer's shops are named generically.
  const staffLabel = async (sid: string | null) => {
    if (!sid) return null;
    const p = await db.query.staff.findFirst({ where: eq(staff.id, sid) });
    if (!p) return null;
    return !scoped || (await inTenant(ctx, "staff", sid)) ? p.displayLabel : OTHER_BARBER;
  };
  const viewer = ratingViewer(ctx);
  const [rating, ratings, rateable] = await Promise.all([ratingSummary(id), ratingHistory(viewer, id, mine), rateableVisits(viewer, id)]);
  const visitStars = new Map<string, number[]>();
  for (const r of ratings) if (r.appointmentId) visitStars.set(r.appointmentId, [...(visitStars.get(r.appointmentId) ?? []), r.stars]);
  const [preferred, usual, homeShop] = await Promise.all([
    staffLabel(c.preferredStaffId),
    staffLabel(stats.usualBarberId),
    c.homeShopId ? db.query.shops.findFirst({ where: eq(shops.id, c.homeShopId) }) : null,
  ]);
  const canSeeSale = (shopId: string) => hasShop(ctx, shopId);
  const homeShopName = homeShop ? (scoped && !hasShop(ctx, homeShop.id) ? OTHER_SHOP : homeShop.name) : null;
  const shopRows = await db.select({ id: shops.id, name: shops.name }).from(shops).orderBy(asc(shops.name));
  const editorShops = scoped ? shopRows.filter((s) => hasShop(ctx, s.id) || s.id === c.homeShopId).map((s) => (hasShop(ctx, s.id) ? s : { ...s, name: OTHER_SHOP })) : shopRows;
  const pager = (key: "v" | "s", pageNo: number, total: number, size: number) =>
    total > size && (
      <div className="flex items-center justify-between px-4 py-3 text-sm">
        {pageNo > 1 ? <Link href={`?${key}=${pageNo - 1}`}>‹ Newer</Link> : <span />}
        <span className="text-zinc-500">
          {(pageNo - 1) * size + 1}–{Math.min(total, pageNo * size)} of {total}
        </span>
        {pageNo * size < total ? <Link href={`?${key}=${pageNo + 1}`}>Older ›</Link> : <span />}
      </div>
    );

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            {`${c.firstName} ${c.lastName ?? ""}`}
            <StarBadge rating={rating} />
          </span>
        }
        subtitle={
          <>
            Client since {formatDate(c.createdAt, "MMM d, yyyy")}
            {homeShopName && ` · Home shop ${homeShopName}`}
            {squireIds.length > 0 && ` · Squire ID${squireIds.length > 1 ? "s" : ""} ${squireIds.map((s) => s.squireId).join(", ")}`}
          </>
        }
        actions={
          <Link className="text-sm underline" href="/admin/customers">
            {full ? "All clients" : "My clients"}
          </Link>
        }
      />
      {sp.existing && <div className="rounded-lg bg-amber-50 px-4 py-2 text-sm text-amber-800">This client was already on file, so no new record was made.</div>}
      {sp.merged && <div className="rounded-lg bg-emerald-50 px-4 py-2 text-sm text-emerald-800">Merged. History, tickets, loyalty, and gift cards from the other record are now on this client.</div>}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat label="Visits" value={stats.visits} hint={[stats.noShows && `${stats.noShows} no-shows`, stats.cancellations && `${stats.cancellations} cancelled`].filter(Boolean).join(" · ") || undefined} tone={stats.noShows ? "down" : undefined} />
        <Stat label="Last visit" value={stats.lastVisit ? formatDate(stats.lastVisit, "MMM d, yyyy") : "—"} hint={stats.upcoming ? `${stats.upcoming} upcoming` : stats.firstVisit ? `first ${formatDate(stats.firstVisit, "MMM yyyy")}` : undefined} />
        {full && (
          <Stat
            label="Lifetime spend"
            value={formatCents(stats.lifetimeSpendCents)}
            hint={`tips ${formatCents(stats.tipsCents)}${stats.squireVisitSpendCents ? ` · ${formatCents(stats.squireVisitSpendCents)} from Squire visit prices` : ""}`}
          />
        )}
        <Stat label="Loyalty progress" value={`${formatCents(loyalty.progressCents)} / ${formatCents(loyalty.thresholdCents)}`} hint={`${formatCents(loyalty.remainingCents)} to next ${formatCents(loyalty.rewardCents)}`} />
        <Stat label="Rewards ready" value={formatCents(loyalty.availableCents)} hint={`${loyalty.rewards.length} reward${loyalty.rewards.length === 1 ? "" : "s"}`} />
        <Stat label="Staff rating" value={rating.count ? `★ ${formatAverage(rating.avg)}` : "—"} hint={rating.count ? `${rating.count} rating${rating.count === 1 ? "" : "s"} · staff only` : "not rated yet"} tone={rating.count && rating.avg < 3 ? "down" : undefined} />
      </div>
      <div className="grid gap-4 lg:grid-cols-[360px_1fr]">
        <div className="space-y-4">
          {full && can(ctx, "clients.edit") ? (
            <CustomerEditor
              id={c.id}
              showContact={showContact}
              initial={{
                firstName: c.firstName,
                lastName: c.lastName ?? "",
                phone: showContact ? (c.phone ?? "") : "",
                email: showContact ? (c.email ?? "") : "",
                notes: c.notes ?? "",
                smsOptIn: c.smsOptIn,
                emailOptIn: c.emailOptIn,
                homeShopId: c.homeShopId,
                preferredStaffId: c.preferredStaffId,
              }}
              shops={editorShops}
              barbers={await Promise.all(
                barberOptions.map(async (b) => ({ id: b.id, label: b.id === c.preferredStaffId ? ((await staffLabel(b.id)) ?? b.label) : b.active ? b.label : `${b.label} (inactive)` })),
              )}
              usualBarber={usual}
            />
          ) : (
            <NotesEditor id={c.id} initial={c.notes ?? ""} preferred={preferred} usual={usual} />
          )}
          <Card>
            <CardHeader title="Loyalty" subtitle={loyalty.rules.earn} />
            <ul className="divide-y divide-zinc-100 text-sm">
              {loyalty.rewards.map((r) => (
                <li key={r.id} className="flex justify-between px-4 py-2">
                  <span>{formatCents(r.amountCents)} reward</span>
                  <span className="text-xs text-zinc-500">{r.expiresAt ? `expires ${formatDateTime(r.expiresAt)}` : "no expiry"}</span>
                </li>
              ))}
              {ledger.map((l) => (
                <li key={l.id} className="flex justify-between px-4 py-1.5 text-xs text-zinc-600">
                  <span className="capitalize">
                    {l.kind.replace(/_/g, " ")} · {formatDateTime(l.createdAt)}
                  </span>
                  <span className="tabular">{l.progressDeltaCents ? formatCents(l.progressDeltaCents, { sign: true }) : formatCents(l.rewardCents, { sign: true })}</span>
                </li>
              ))}
            </ul>
            {can(ctx, "loyalty.grant") && <GrantReward customerId={c.id} />}
          </Card>
          {canMerge && (
            <Card>
              <CardHeader title="Duplicates" subtitle="Merge another record into this client. Its visits, tickets, loyalty, gift cards, and Squire IDs move here." />
              {dupes.length > 0 && (
                <ul className="divide-y divide-zinc-100 text-sm">
                  {dupes.map((d) => {
                    const other = d.a.id === c.id ? d.b : d.a;
                    return (
                      <li key={other.id} className="flex items-center justify-between gap-2 px-4 py-2">
                        <Link className="truncate underline" href={`/admin/customers/${other.id}`}>
                          {other.firstName} {other.lastName}
                        </Link>
                        <Badge tone={d.kind === "likely" ? "amber" : "gray"}>{d.kind === "likely" ? "likely same" : d.kind === "same_name" ? "same name" : "shares contact"}</Badge>
                      </li>
                    );
                  })}
                </ul>
              )}
              <MergeInto keepId={c.id} keepName={`${c.firstName} ${c.lastName ?? ""}`.trim()} suggestions={dupes.map((d) => (d.a.id === c.id ? d.b : d.a)).map((o) => ({ id: o.id, label: `${o.firstName} ${o.lastName ?? ""}`.trim() }))} />
            </Card>
          )}
        </div>
        <div className="space-y-4">
          <Card>
            <CardHeader
              title="Staff ratings"
              subtitle={
                seesAllRatings(viewer)
                  ? "Private to staff. Never shown to the client, on the booking site, or in the app."
                  : `Average from every barber's ratings. You see the ratings you gave.`
              }
            />
            {rating.count > 0 && (
              <div className="flex flex-wrap items-center gap-x-6 gap-y-2 px-4 pt-3 text-xs text-zinc-600">
                <span className="text-sm">
                  <span className="font-semibold">{formatAverage(rating.avg)}</span> average from {rating.count} rating{rating.count === 1 ? "" : "s"}
                </span>
                {([5, 4, 3, 2, 1] as const).map((n) => (
                  <span key={n} className="tabular">
                    {n}★ {rating.byStars[n]}
                  </span>
                ))}
              </div>
            )}
            {ratings.length > 0 && (
              <RatingHistory
                canRemoveAny={viewer.moderates}
                rows={ratings.map((r) => ({
                  id: r.id,
                  stars: r.stars,
                  note: r.note,
                  ratedBy: r.ratedBy,
                  when: formatDateTime(r.createdAt),
                  edited: r.updatedAt.getTime() - r.createdAt.getTime() > 1000,
                  shop: r.shop,
                  visit: `${r.visitAt ? `visit ${formatDate(r.visitAt, "MMM d, yyyy")}` : "visit"}${r.saleNumber ? ` (ticket #${r.saleNumber})` : ""}`,
                  visitHref: r.saleId && full && ctx.shopIds.includes(r.shopId) ? `/admin/sales/${r.saleId}` : null,
                  mine: r.mine,
                }))}
              />
            )}
            <RateVisitForm
              customerId={c.id}
              visits={rateable.map((v) => ({
                key: v.appointmentId ?? `sale:${v.saleId}`,
                appointmentId: v.appointmentId,
                saleId: v.saleId,
                label: `${formatDate(v.at, "MMM d, yyyy")} · ${v.shop}${v.barber ? ` · ${v.barber}` : ""} · ${v.label}`,
                myRating: v.myRating,
              }))}
            />
          </Card>
          <Card>
            <CardHeader
              title="Visit history"
              subtitle={
                scoped
                  ? `${visitCount} appointment${visitCount === 1 ? "" : "s"} at ${ctx.shops.length === 1 ? ctx.shops[0].name : "your shops"}, including Squire history${elsewhere.n ? ` · ${elsewhere.n} visit${elsewhere.n === 1 ? "" : "s"} at other Ray'z shops` : ""}`
                  : `${visitCount} appointment${visitCount === 1 ? "" : "s"} at every shop, including Squire history`
              }
            />
            <Table>
              <thead>
                <tr>
                  <Th>When</Th>
                  <Th>Shop</Th>
                  <Th>Barber</Th>
                  <Th>Services</Th>
                  <Th right>Price</Th>
                  <Th>Status</Th>
                  <Th>Rating</Th>
                </tr>
              </thead>
              <tbody>
                {visits.map((v) => (
                  <tr key={v.a.id}>
                    <Td className="whitespace-nowrap">{formatDateTime(v.a.startsAt)}</Td>
                    <Td>{v.shop}</Td>
                    <Td>{v.barber}</Td>
                    <Td className="max-w-xs truncate">
                      {v.items}
                      {v.a.source === "import" && <span className="ml-1 text-xs text-zinc-400">Squire</span>}
                    </Td>
                    <Td right>{formatCents(v.paid ?? v.a.estimateCents)}</Td>
                    <Td>
                      <StatusBadge status={v.a.status} />
                    </Td>
                    <Td className="whitespace-nowrap text-xs">{visitStars.get(v.a.id)?.map((n, k) => <Stars key={k} n={n} />) ?? null}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            {pager("v", vPage, visitCount, VISITS_PAGE)}
          </Card>
          {full && (
            <Card>
              <CardHeader title="Purchases" subtitle={`${saleCount} ticket${saleCount === 1 ? "" : "s"} · lifetime ${formatCents(stats.ticketSpendCents)} after refunds`} />
              <Table>
                <thead>
                  <tr>
                    <Th>#</Th>
                    <Th>Date</Th>
                    <Th>Shop</Th>
                    <Th right>Services</Th>
                    <Th right>Products</Th>
                    <Th right>Tip</Th>
                    <Th right>Total</Th>
                    <Th>Status</Th>
                  </tr>
                </thead>
                <tbody>
                  {saleRows.map(({ s, shop, refunded }) => (
                    <tr key={s.id}>
                      <Td>{canSeeSale(s.shopId) ? <Link className="underline" href={`/admin/sales/${s.id}`}>{s.number}</Link> : s.number}</Td>
                      <Td>{s.businessDate}</Td>
                      <Td>{shop}</Td>
                      <Td right>{formatCents(s.serviceNetCents)}</Td>
                      <Td right>{formatCents(s.productNetCents)}</Td>
                      <Td right>{formatCents(s.tipCents)}</Td>
                      <Td right>
                        {formatCents(s.totalCents)}
                        {refunded > 0 && <div className="text-xs text-red-600">−{formatCents(refunded)} refunded</div>}
                      </Td>
                      <Td className="capitalize">
                        {s.status.replace("_", " ")}
                        {s.isImported && <span className="ml-1 text-xs text-zinc-400">Squire</span>}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
              {pager("s", sPage, saleCount, SALES_PAGE)}
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
