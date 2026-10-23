import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { and, asc, desc, eq, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { appointments, customerSquireIds, customerTags, customers, loyaltyLedger, messageThreads, sales, shops, staff } from "@/db/schema";
import { Badge, Card, CardHeader, PageHeader, Stat, StarBadge, StatusBadge, Table, Td, Th } from "@/components/ui";
import { RATINGS_MASKED_HINT, type ShownField, customFieldKey } from "@/domain/client-privacy";
import { formatAverage, seesAllRatings } from "@/domain/ratings";
import { formatPhone } from "@/lib/phone";
import { formatCents } from "@/lib/money";
import { formatDate, formatDateTime } from "@/lib/time";
import { can, guardPage, ratingViewer } from "@/server/auth/staff";
import { PAUSED_MESSAGE, clientPolicy, isPaused, recordClientAccess, shownField } from "@/server/client-privacy";
import { customerAccess, customerStats, duplicatePairs } from "@/server/customers";
import { loyaltyBalance } from "@/server/loyalty";
import { rateableVisits, ratingHistory, ratingSummary } from "@/server/ratings";
import { latestReceipts, receiptOnFile } from "@/server/receipts";
import { CALL_KIND_LABEL, CALL_STATUS_LABEL, callsWith, optOutKeys } from "@/server/messaging";
import { hasShop, inShops } from "@/server/tenant";
import { RateVisitForm, RatingHistory, Stars } from "../ratings";
import { ContactClient } from "../privacy";
import { ResendReceipt } from "../../sales/[id]/receipt-panel";
import { CustomerEditor, GrantReward, MergeInto, NotesEditor } from "./editor";
import { ClientTags } from "./tags";

export const metadata: Metadata = { title: "Client" };

const VISITS_PAGE = 25;
const SALES_PAGE = 15;

export default async function CustomerPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ v?: string; s?: string; merged?: string; existing?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const ctx = await guardPage("/admin/customers/[id]");
  const access = await customerAccess({ staffId: ctx.staff.id, viewAll: can(ctx, "clients.view_all") }, id);
  if (!access) redirect("/admin/customers");
  const full = access === "full";
  const canMerge = full && can(ctx, "clients.merge");
  const c = await db.query.customers.findFirst({ where: eq(customers.id, id) });
  if (!c) notFound();
  try {
    await recordClientAccess(ctx, { kind: "view", customerId: id });
  } catch (e) {
    if (!isPaused(e)) throw e;
    return (
      <div className="mx-auto max-w-xl">
        <PageHeader title="Client lookups paused" />
        <Card className="p-5 text-sm text-zinc-700">{PAUSED_MESSAGE}</Card>
      </div>
    );
  }
  const policy = await clientPolicy(ctx);
  const preferredFull = policy.level("preferred_barber") === "full";
  // The client's history follows them: every shop sees their visits and purchases at every shop.
  // Staff ratings and notes stay with the shop they were written at; tickets open only at their own shop.
  const scoped = !ctx.brandWide;
  const mine = scoped ? ctx.shopIds : undefined;
  const vPage = Math.max(1, Number(sp.v) || 1);
  const sPage = Math.max(1, Number(sp.s) || 1);

  const [stats, visits, [{ visitCount }], saleRows, [{ saleCount }], loyalty, ledger, squireIds, dupes, barberOptions] = await Promise.all([
    customerStats(id, db, new Date()),
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
      .where(eq(appointments.customerId, id))
      .orderBy(desc(appointments.startsAt))
      .limit(VISITS_PAGE)
      .offset((vPage - 1) * VISITS_PAGE),
    db
      .select({ visitCount: sql<number>`count(*)::int` })
      .from(appointments)
      .where(eq(appointments.customerId, id)),
    full
      ? db
          .select({
            s: sales,
            shop: shops.name,
            refunded: sql<number>`(select coalesce(sum(r.amount_cents), 0)::int from refunds r where r.sale_id = ${sales.id} and r.kind = 'refund')`,
          })
          .from(sales)
          .innerJoin(shops, eq(shops.id, sales.shopId))
          .where(and(eq(sales.customerId, id), sql`${sales.status} <> 'open'`))
          .orderBy(desc(sales.businessDate), desc(sales.createdAt))
          .limit(SALES_PAGE)
          .offset((sPage - 1) * SALES_PAGE)
      : [],
    full
      ? db
          .select({ saleCount: sql<number>`count(*)::int` })
          .from(sales)
          .where(and(eq(sales.customerId, id), sql`${sales.status} <> 'open'`))
      : [{ saleCount: 0 }],
    loyaltyBalance(id),
    db.select().from(loyaltyLedger).where(eq(loyaltyLedger.customerId, id)).orderBy(desc(loyaltyLedger.createdAt)).limit(20),
    db.select().from(customerSquireIds).where(eq(customerSquireIds.customerId, id)).orderBy(asc(customerSquireIds.createdAt)),
    canMerge ? duplicatePairs({ forId: id, limit: 10 }) : [],
    full && preferredFull
      ? db
          .select({ id: staff.id, label: staff.displayLabel, active: staff.active })
          .from(staff)
          .where(
            or(
              and(
                eq(staff.active, true),
                eq(staff.isBookable, true),
                scoped ? sql`exists (select 1 from staff_shops ss where ss.staff_id = ${staff.id} and ${inShops(ctx, sql`ss.shop_id`)})` : undefined,
              ),
              c.preferredStaffId ? eq(staff.id, c.preferredStaffId) : undefined,
            ),
          )
          .orderBy(asc(staff.displayLabel))
      : [],
  ]);
  const [tags, knownTags] = full
    ? await Promise.all([
        db.select({ tag: customerTags.tag }).from(customerTags).where(eq(customerTags.customerId, id)).orderBy(asc(customerTags.tag)),
        can(ctx, "clients.edit") ? db.selectDistinct({ tag: customerTags.tag }).from(customerTags).orderBy(asc(customerTags.tag)).limit(100) : [],
      ])
    : [[], []];
  const staffLabel = async (sid: string | null) =>
    sid ? ((await db.query.staff.findFirst({ where: eq(staff.id, sid), columns: { displayLabel: true } }))?.displayLabel ?? null) : null;
  const viewer = ratingViewer(ctx);
  const [ratingAll, ratings, rateable] = await Promise.all([
    ratingSummary(id),
    policy.ratingDetail ? ratingHistory(viewer, id, mine) : [],
    policy.ratingDetail ? rateableVisits(viewer, id) : [],
  ]);
  const rating = policy.stars(ratingAll);
  const visitStars = new Map<string, number[]>();
  for (const r of ratings) if (r.appointmentId) visitStars.set(r.appointmentId, [...(visitStars.get(r.appointmentId) ?? []), r.stars]);
  const [preferred, usual, homeShop] = await Promise.all([
    staffLabel(c.preferredStaffId),
    staffLabel(stats.usualBarberId),
    c.homeShopId ? db.query.shops.findFirst({ where: eq(shops.id, c.homeShopId) }) : null,
  ]);
  const canSeeSale = (shopId: string) => hasShop(ctx, shopId);
  const homeShopName = homeShop?.name ?? null;
  const shopRows = (await db.select({ id: shops.id, name: shops.name, status: shops.status }).from(shops).orderBy(asc(shops.name))).filter((s) => s.status !== "archived" || s.id === c.homeShopId);
  const editorShops = scoped ? shopRows.filter((s) => hasShop(ctx, s.id) || s.id === c.homeShopId) : shopRows;
  const stored = { phone: c.phone, email: c.email, address: c.address, birthday: c.birthday, notes: c.notes };
  const fields: ShownField[] = [
    ...(["phone", "email", "address", "birthday", "notes"] as const).map((f) => shownField(policy, f, stored[f])),
    ...policy.custom.map((f) => shownField(policy, customFieldKey(f.id), c.customFields[f.id], f.label)),
  ];
  const preferredShown: ShownField = { ...shownField(policy, "preferred_barber", preferred), saved: !!c.preferredStaffId };
  const isFull = (k: string) => fields.find((f) => f.key === k)?.level === "full";
  // Only what the person sees in full goes into a form's inputs; everything else is shown through `fields`.
  const fullValues = Object.fromEntries(
    [
      ...Object.entries(stored).map(([k, v]) => [k, k === "phone" && v ? formatPhone(v) || v : v] as const),
      ...policy.custom.map((f) => [customFieldKey(f.id), c.customFields[f.id]] as const),
    ].flatMap(([k, v]) => (isFull(k) ? [[k, v ?? ""]] : [])),
  );
  const canMessage = can(ctx, "clients.message");
  const [receiptFile, receipts] = await Promise.all([receiptOnFile(policy, { phone: c.phone, email: c.email }), latestReceipts(saleRows.map((r) => r.s.id))]);
  const receiptLabel = (r: { channel: string; masked: string | null } | undefined) => (!r ? null : r.channel === "none" ? "No receipt" : `${r.channel === "sms" ? "Texted" : "Emailed"} ${r.masked}`);
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
            {rating && <StarBadge rating={rating} />}
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
      {sp.merged && (
        <div className="rounded-lg bg-emerald-50 px-4 py-2 text-sm text-emerald-800">
          Merged. History, tickets, loyalty, and gift cards from the other record are now on this client.
        </div>
      )}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat
          label="Visits"
          value={stats.visits}
          hint={[stats.noShows && `${stats.noShows} no-shows`, stats.cancellations && `${stats.cancellations} cancelled`].filter(Boolean).join(" · ") || undefined}
          tone={stats.noShows ? "down" : undefined}
        />
        <Stat
          label="Last visit"
          value={stats.lastVisit ? formatDate(stats.lastVisit, "MMM d, yyyy") : "—"}
          hint={stats.upcoming ? `${stats.upcoming} upcoming` : stats.firstVisit ? `first ${formatDate(stats.firstVisit, "MMM yyyy")}` : undefined}
        />
        {full && (
          <Stat
            label="Lifetime spend"
            value={formatCents(stats.lifetimeSpendCents)}
            hint={`tips ${formatCents(stats.tipsCents)}${stats.squireVisitSpendCents ? ` · ${formatCents(stats.squireVisitSpendCents)} from Squire visit prices` : ""}`}
          />
        )}
        <Stat
          label="Loyalty progress"
          value={`${formatCents(loyalty.progressCents)} / ${formatCents(loyalty.thresholdCents)}`}
          hint={`${formatCents(loyalty.remainingCents)} to next ${formatCents(loyalty.rewardCents)}`}
        />
        <Stat label="Rewards ready" value={formatCents(loyalty.availableCents)} hint={`${loyalty.rewards.length} reward${loyalty.rewards.length === 1 ? "" : "s"}`} />
        {rating && (
          <Stat
            label="Staff rating"
            value={rating.count ? `★ ${formatAverage(rating.avg)}` : "—"}
            hint={rating.count ? `${rating.count} rating${rating.count === 1 ? "" : "s"} · staff only` : "not rated yet"}
            tone={rating.count && rating.avg < 3 ? "down" : undefined}
          />
        )}
      </div>
      <div className="grid gap-4 lg:grid-cols-[360px_1fr]">
        <div className="space-y-4">
          {full && can(ctx, "clients.edit") ? (
            <CustomerEditor
              id={c.id}
              fields={fields}
              canReveal={policy.canReveal}
              preferred={preferredShown}
              values={fullValues}
              initial={{
                firstName: c.firstName,
                lastName: c.lastName ?? "",
                smsOptIn: c.smsOptIn,
                emailOptIn: c.emailOptIn,
                allowOtherShop: c.allowOtherShop,
                homeShopId: c.homeShopId,
                preferredStaffId: preferredFull ? c.preferredStaffId : null,
              }}
              shops={editorShops}
              barbers={await Promise.all(
                barberOptions.map(async (b) => ({
                  id: b.id,
                  label: b.id === c.preferredStaffId ? ((await staffLabel(b.id)) ?? b.label) : b.active ? b.label : `${b.label} (inactive)`,
                })),
              )}
              usualBarber={usual}
            />
          ) : (
            <NotesEditor
              id={c.id}
              initial={isFull("notes") ? (c.notes ?? "") : ""}
              notes={fields.find((f) => f.key === "notes")!}
              fields={fields.filter((f) => f.key !== "notes")}
              canReveal={policy.canReveal}
              preferred={preferredShown.value}
              usual={usual}
            />
          )}
          {canMessage && (
            <Card>
              <CardHeader title="Contact" subtitle="Calls and texts go through the shop line, so the client's number stays private." />
              <div className="p-4">
                <ContactClient customerId={c.id} canText={c.smsOptIn} hasPhone={!!c.phone} />
                {!c.smsOptIn && c.phone && <p className="mt-2 text-xs text-zinc-500">This client hasn&apos;t opted in to texts.</p>}
              </div>
            </Card>
          )}
          {full && (
            <Card>
              <CardHeader title="Tags" subtitle="For Campaign Center segments, e.g. VIP or Student." />
              <ClientTags customerId={c.id} tags={tags.map((t) => t.tag)} known={knownTags.map((t) => t.tag)} canEdit={can(ctx, "clients.edit")} />
            </Card>
          )}
          {c.phone && <CallsAndTexts customerId={c.id} shopIds={ctx.brandWide ? null : ctx.shopIds} canInbox={can(ctx, "inbox.view")} />}
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
              <MergeInto
                keepId={c.id}
                keepName={`${c.firstName} ${c.lastName ?? ""}`.trim()}
                suggestions={dupes.map((d) => (d.a.id === c.id ? d.b : d.a)).map((o) => ({ id: o.id, label: `${o.firstName} ${o.lastName ?? ""}`.trim() }))}
              />
            </Card>
          )}
        </div>
        <div className="space-y-4">
          {rating && !policy.ratingDetail && (
            <Card>
              <CardHeader title="Staff ratings" subtitle={RATINGS_MASKED_HINT} />
              <p className="px-4 py-3 text-sm">
                {rating.count ? `${formatAverage(rating.avg)} average from ${rating.count} rating${rating.count === 1 ? "" : "s"}` : "Not rated yet"}
              </p>
            </Card>
          )}
          {rating && policy.ratingDetail && (
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
          )}
          <Card>
            <CardHeader title="Visit history" subtitle={`${visitCount} appointment${visitCount === 1 ? "" : "s"} at every Ray'z shop, including Squire history`} />
            <Table>
              <thead>
                <tr>
                  <Th>When</Th>
                  <Th>Shop</Th>
                  <Th>Barber</Th>
                  <Th>Services</Th>
                  <Th right>Price</Th>
                  <Th>Status</Th>
                  {policy.ratingDetail && <Th>Rating</Th>}
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
                    {policy.ratingDetail && <Td className="whitespace-nowrap text-xs">{visitStars.get(v.a.id)?.map((n, k) => <Stars key={k} n={n} />) ?? null}</Td>}
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
                    <Th>Receipt</Th>
                  </tr>
                </thead>
                <tbody>
                  {saleRows.map(({ s, shop, refunded }) => (
                    <tr key={s.id}>
                      <Td>
                        {canSeeSale(s.shopId) ? (
                          <Link className="underline" href={`/admin/sales/${s.id}`}>
                            {s.number}
                          </Link>
                        ) : (
                          s.number
                        )}
                      </Td>
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
                      <Td>
                        {canSeeSale(s.shopId) && !s.isImported && (
                          <ResendReceipt saleId={s.id} onFile={receiptFile} last={receiptLabel(receipts.get(s.id))} />
                        )}
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

/** Calls with the client's number and the shop inbox threads, without the number itself. */
async function CallsAndTexts({ customerId, shopIds, canInbox }: { customerId: string; shopIds: string[] | null; canInbox: boolean }) {
  const phone = (await db.query.customers.findFirst({ where: eq(customers.id, customerId), columns: { phone: true } }))?.phone;
  if (!phone) return null;
  const [calls, keys, threads] = await Promise.all([
    callsWith(phone, shopIds, 10),
    optOutKeys([phone]),
    canInbox
      ? db
          .select({ id: messageThreads.id, shop: shops.name, at: messageThreads.lastMessageAt, unread: messageThreads.unread })
          .from(messageThreads)
          .innerJoin(shops, eq(shops.id, messageThreads.shopId))
          .where(and(eq(messageThreads.phone, phone), shopIds ? inShops({ shopIds }, messageThreads.shopId) : undefined))
          .orderBy(desc(messageThreads.lastMessageAt))
      : Promise.resolve([]),
  ]);
  const stopped = keys.has(`sms:${phone}`);
  const noCalls = keys.has(`voice:${phone}`);
  if (!calls.length && !threads.length && !stopped && !noCalls) return null;
  return (
    <Card>
      <CardHeader title="Calls and texts" subtitle="With the shop numbers. The number itself stays private." />
      {(stopped || noCalls) && (
        <div className="space-y-1 border-b border-zinc-100 px-4 py-2 text-xs text-amber-800">
          {stopped && <p>Replied STOP: no texts until they reply START.</p>}
          {noCalls && <p>Asked for no automated calls (pressed 9).</p>}
        </div>
      )}
      {threads.length > 0 && (
        <ul className="divide-y divide-zinc-100 border-b border-zinc-100 text-sm">
          {threads.map((t) => (
            <li key={t.id} className="flex items-center justify-between px-4 py-2">
              <Link className="underline underline-offset-2" href={`/admin/inbox/${t.id}`}>
                Texts with {t.shop}
              </Link>
              <span className="text-xs text-zinc-500">
                {t.unread > 0 && <Badge tone="blue">{t.unread} new</Badge>} {formatDateTime(t.at)}
              </span>
            </li>
          ))}
        </ul>
      )}
      {calls.length > 0 && (
        <ul className="divide-y divide-zinc-100 text-sm">
          {calls.map(({ c, shopName, staffLabel }) => (
            <li key={c.id} className="px-4 py-2">
              <div className="flex items-center justify-between gap-2">
                <span>{CALL_KIND_LABEL[c.kind]}</span>
                <Badge tone={c.status === "missed" || c.status === "no_answer" || c.status === "failed" ? "amber" : "gray"}>{CALL_STATUS_LABEL[c.status]}</Badge>
              </div>
              <div className="text-xs text-zinc-500">
                {formatDateTime(c.createdAt)}
                {shopName && ` · ${shopName}`}
                {staffLabel && ` · ${staffLabel}`}
                {c.durationSec ? ` · ${Math.round(c.durationSec / 60) || "<1"} min` : ""}
                {c.digits && ` · pressed ${c.digits}`}
                {c.autoTextSent && " · texted a link"}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
