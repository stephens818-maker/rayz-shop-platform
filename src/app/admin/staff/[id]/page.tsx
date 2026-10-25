import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { and, asc, eq, gt } from "drizzle-orm";
import { db } from "@/db";
import { roles, shopHours, shops, staff, staffSchedules, staffShops, timeBlocks } from "@/db/schema";
import { Card, CardHeader, Notice, PageHeader } from "@/components/ui";
import { TrophyCase } from "@/components/trophy-case";
import { assignableRoles, staffEditDenied } from "@/domain/permissions";
import { seesStaffContact, staffContact } from "@/domain/staff-contact";
import { formatDateTime } from "@/lib/time";
import { accessState, loadStaffAccess } from "@/server/auth/access";
import { can, guardPage, reasonViewer, staffGrantor } from "@/server/auth/staff";
import { pickerReasons, reasonShower } from "@/server/block-reasons";
import { compensationAccess, loadCompensationSettings } from "@/server/compensation";
import { OTHER_SHOP, hasShop, inTenant } from "@/server/tenant";
import { barberIntervalRows } from "@/server/timing";
import { StaffTimingCard } from "../../booking-times/editors";
import { loadMilestoneSettings } from "@/server/milestones/engine";
import { milestoneViewer, personFor, trophyCase } from "@/server/milestones/views";
import { futureBookings } from "@/server/offboarding";
import { AffectedRow } from "../../time-off/client";
import { OffboardCard, ProfileForm, ScheduleEditor, TimeOff } from "./editors";
import { BookingOptionsCard, DaysOnCard, NotificationsCard } from "./settings";
import { dayHistory, loadBookingOptions, loadNotificationPrefs } from "@/server/staff-settings";

export const metadata: Metadata = { title: "Staff member" };

export default async function StaffDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await guardPage("/admin/staff/[id]");
  const isNew = id === "new";
  if (isNew && !can(ctx, "staff.manage")) notFound();
  if (!isNew && id !== ctx.staff.id && !(await inTenant(ctx, "staff", id))) notFound();
  const person = isNew ? null : await db.query.staff.findFirst({ where: eq(staff.id, id) });
  if (!isNew && !person) notFound();
  const shopRows = await db.select({ id: shops.id, name: shops.name, status: shops.status }).from(shops).orderBy(asc(shops.name));
  const editableShops = (ctx.brandWide ? shopRows : shopRows.filter((s) => hasShop(ctx, s.id))).filter((s) => s.status !== "archived");
  const allShops = ctx.brandWide ? shopRows : shopRows.map((s) => (hasShop(ctx, s.id) ? s : { ...s, name: OTHER_SHOP }));
  const mine = <T extends { shopId: string | null }>(rows: T[]) => (ctx.brandWide ? rows : rows.filter((r) => !r.shopId || hasShop(ctx, r.shopId)));
  const [links, scheds, hours, blocks] = person
    ? await Promise.all([
        db.select().from(staffShops).where(eq(staffShops.staffId, person.id)),
        db.select().from(staffSchedules).where(eq(staffSchedules.staffId, person.id)).then(mine),
        db.select().from(shopHours).then(mine),
        db.select().from(timeBlocks).where(and(eq(timeBlocks.staffId, person.id), gt(timeBlocks.endsAt, new Date()))).orderBy(asc(timeBlocks.startsAt)).limit(50).then(mine),
      ])
    : [[], [], await db.select().from(shopHours).then(mine), []];
  const target = person ? await loadStaffAccess(person.id) : null;
  const editDenied = !can(ctx, "staff.manage")
    ? "You can view this person but not edit their profile."
    : target
      ? staffEditDenied(staffGrantor(ctx), { ...accessState(target), workShopIds: links.map((l) => l.shopId) })
      : null;
  const roleChoices = isNew
    ? assignableRoles(staffGrantor(ctx), await db.select().from(roles).orderBy(asc(roles.sortOrder), asc(roles.name))).filter((r) => r.defaultScope !== "all" || ctx.brandWide)
    : [];
  const contact = person ? staffContact(seesStaffContact({ permissions: ctx.permissions, staffId: ctx.staff.id }, person.id), person) : null;
  const canSchedule = can(ctx, "schedules.edit");
  const timing = person && person.kind === "person" && can(ctx, "scheduling.timing") ? (await barberIntervalRows(ctx, person.id))[0] : undefined;
  const [show, offReasons] = await Promise.all([reasonShower(reasonViewer(ctx)), pickerReasons("time_off")]);
  const canOffboard = !!person && person.active && person.id !== ctx.staff.id && !editDenied && !target?.isOwner;
  const seesPay = !!person && (await loadCompensationSettings()).enabled && (await compensationAccess(ctx, person.id)).view;
  const milestones = person && person.kind === "person" ? await staffTrophies(ctx, person.id) : null;
  const ahead = person && !person.active && can(ctx, "timeoff.approve") ? (await futureBookings(person.id)).filter((a) => hasShop(ctx, a.shopId)) : [];
  const isPerson = !!person && person.kind === "person";
  const [bookingView, prefs, days] = isPerson
    ? await Promise.all([loadBookingOptions(ctx, person!.id), loadNotificationPrefs(person!.id), canSchedule ? dayHistory(person!.id, ctx.brandWide ? null : ctx.shopIds) : Promise.resolve([])])
    : [null, null, []];
  const ownOrManager = isPerson && (person!.id === ctx.staff.id || (can(ctx, "staff.manage") && !editDenied));

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <PageHeader
        title={person ? person.displayLabel : "Add staff"}
        subtitle={
          person ? (
            <>
              {person.staffCode} · {target?.role.name} · booking link slug <span className="font-mono">{person.publicSlug}</span> (first name only)
            </>
          ) : (
            "Staff ID and booking slug are generated automatically."
          )
        }
        actions={
          <div className="flex gap-3 text-sm">
            {person && seesPay && (
              <Link className="underline" href={`/admin/staff/${person.id}/compensation`}>
                Compensation
              </Link>
            )}
            {person && can(ctx, "permissions.manage") && (
              <Link className="underline" href={`/admin/permissions/people/${person.id}`}>
                Role & permissions
              </Link>
            )}
            <Link className="underline" href="/admin/staff">
              All staff
            </Link>
          </div>
        }
      />
      {editDenied && <Notice tone="blue">{editDenied}</Notice>}
      <ProfileForm
        readOnly={!!editDenied}
        contactMasked={!!contact?.masked}
        shops={editableShops}
        allShops={allShops}
        roles={roleChoices.map((r) => ({ id: r.id, name: r.name, description: r.description, defaultScope: r.defaultScope }))}
        initial={
          person
            ? {
                id: person.id,
                firstName: person.firstName,
                lastName: person.lastName ?? "",
                displayLabel: person.displayLabel,
                email: contact?.email ?? "",
                phone: contact?.phone ?? "",
                color: person.color,
                roleId: person.roleId,
                isBookable: person.isBookable,
                active: person.active,
                squireName: person.squireName ?? "",
                hireDate: person.hireDate ?? "",
                shopIds: links.map((l) => l.shopId),
                hasLogin: !!person.passwordHash,
              }
            : null
        }
      />
      {person && canSchedule && (
        <>
          <ScheduleEditor
            staffId={person.id}
            shops={editableShops.filter((s) => links.some((l) => l.shopId === s.id)).map((s) => ({ ...s, editable: true }))}
            schedules={scheds.map((s) => ({ shopId: s.shopId, weekday: s.weekday, startMin: s.startMin, endMin: s.endMin }))}
            hours={hours.map((h) => ({ shopId: h.shopId, weekday: h.weekday, openMin: h.openMin, closeMin: h.closeMin }))}
          />
          <TimeOff
            staffId={person.id}
            shops={editableShops.filter((s) => links.some((l) => l.shopId === s.id))}
            reasons={offReasons}
            blocks={blocks.map((b) => ({
              id: b.id,
              label: `${formatDateTime(b.startsAt)} → ${formatDateTime(b.endsAt)}`,
              reason: show(b, b.category === "time_off" || b.kind === "day_off"),
              kind: b.kind,
              shop: b.shopId ? (allShops.find((s) => s.id === b.shopId)?.name ?? "") : "All shops",
            }))}
          />
          {isPerson && (
            <DaysOnCard
              staffId={person.id}
              shops={editableShops.filter((s) => links.some((l) => l.shopId === s.id))}
              history={days.map((d) => ({ ...d, shopName: d.shopId ? (allShops.find((s) => s.id === d.shopId)?.name ?? "") : "All shops" }))}
              canEdit
            />
          )}
        </>
      )}
      {bookingView && (can(ctx, "staff.manage") || person!.id === ctx.staff.id) && <BookingOptionsCard staffId={person!.id} view={bookingView} canEdit={can(ctx, "staff.manage") && !editDenied} />}
      {prefs && ownOrManager && <NotificationsCard staffId={person!.id} prefs={prefs} canEdit={ownOrManager} self={person!.id === ctx.staff.id} />}
      {milestones && (
        <Card>
          <CardHeader
            title="Trophy case"
            subtitle={person!.hireDate ? undefined : "Add a hire date above for work anniversaries."}
            action={
              <Link className="text-sm text-brand-700 hover:underline" href={milestones.own ? "/admin/milestones" : `/admin/milestones?staff=${person!.id}`}>
                Milestones
              </Link>
            }
          />
          <TrophyCase trophies={milestones.trophies} bests={milestones.bests} money={milestones.money} empty="No milestones yet." />
        </Card>
      )}
      {timing && <StaffTimingCard barber={timing} />}
      {person && person.kind === "person" && (ahead.length > 0 || canOffboard) && (
        <>
          {ahead.length > 0 && !person.active && (
            <Card>
              <CardHeader title="Still booked with them" subtitle="Move these to another barber or ask the client to pick a new time." />
              <ul className="divide-y divide-zinc-100">
                {ahead.map((a) => (
                  <AffectedRow key={a.id} a={a} />
                ))}
              </ul>
            </Card>
          )}
          {canOffboard && <OffboardCard staffId={person.id} label={person.displayLabel} />}
        </>
      )}
    </div>
  );
}

async function staffTrophies(ctx: Awaited<ReturnType<typeof guardPage>>, staffId: string) {
  const s = await loadMilestoneSettings();
  if (!s.enabled) return null;
  const p = await personFor(await milestoneViewer(ctx), s, staffId);
  if (!p) return null;
  return { ...(await trophyCase(staffId)), money: p.rel !== "team", own: p.rel === "own" };
}
