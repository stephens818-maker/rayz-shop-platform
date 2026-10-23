import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { and, asc, eq, gt } from "drizzle-orm";
import { db } from "@/db";
import { roles, shopHours, shops, staff, staffSchedules, staffShops, timeBlocks } from "@/db/schema";
import { Notice, PageHeader } from "@/components/ui";
import { assignableRoles, staffEditDenied } from "@/domain/permissions";
import { formatDateTime } from "@/lib/time";
import { accessState, loadStaffAccess } from "@/server/auth/access";
import { can, guardPage, staffGrantor } from "@/server/auth/staff";
import { OTHER_SHOP, hasShop, inTenant } from "@/server/tenant";
import { barberIntervalRows } from "@/server/timing";
import { StaffTimingCard } from "../../booking-times/editors";
import { ProfileForm, ScheduleEditor, TimeOff } from "./editors";

export const metadata: Metadata = { title: "Staff member" };

export default async function StaffDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await guardPage("/admin/staff/[id]");
  const isNew = id === "new";
  if (isNew && !can(ctx, "staff.manage")) notFound();
  if (!isNew && id !== ctx.staff.id && !(await inTenant(ctx, "staff", id))) notFound();
  const person = isNew ? null : await db.query.staff.findFirst({ where: eq(staff.id, id) });
  if (!isNew && !person) notFound();
  const shopRows = await db.select({ id: shops.id, name: shops.name }).from(shops).orderBy(asc(shops.name));
  const editableShops = ctx.brandWide ? shopRows : shopRows.filter((s) => hasShop(ctx, s.id));
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
  const canSchedule = can(ctx, "schedules.edit");
  const timing = person && person.kind === "person" && can(ctx, "scheduling.timing") ? (await barberIntervalRows(ctx, person.id))[0] : undefined;

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
                email: person.email ?? "",
                phone: person.phone ?? "",
                color: person.color,
                roleId: person.roleId,
                isBookable: person.isBookable,
                active: person.active,
                squireName: person.squireName ?? "",
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
            blocks={blocks.map((b) => ({
              id: b.id,
              label: `${formatDateTime(b.startsAt)} → ${formatDateTime(b.endsAt)}`,
              reason: b.reason,
              kind: b.kind,
              shop: b.shopId ? (allShops.find((s) => s.id === b.shopId)?.name ?? "") : "All shops",
            }))}
          />
        </>
      )}
      {timing && <StaffTimingCard barber={timing} />}
    </div>
  );
}
