import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { and, asc, eq, gt } from "drizzle-orm";
import { db } from "@/db";
import { shopHours, shops, staff, staffSchedules, staffShops, timeBlocks } from "@/db/schema";
import { PageHeader } from "@/components/ui";
import { formatDateTime } from "@/lib/time";
import { requireStaff } from "@/server/auth/staff";
import { ProfileForm, ScheduleEditor, TimeOff } from "./editors";

export const metadata: Metadata = { title: "Staff member" };

export default async function StaffDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireStaff(["brand_admin", "shop_manager"]);
  const isNew = id === "new";
  const person = isNew ? null : await db.query.staff.findFirst({ where: eq(staff.id, id) });
  if (!isNew && !person) notFound();
  const allShops = await db.select({ id: shops.id, name: shops.name }).from(shops).orderBy(asc(shops.name));
  const editableShops = ctx.isAdmin ? allShops : allShops.filter((s) => ctx.shopIds.includes(s.id));
  const [links, scheds, hours, blocks] = person
    ? await Promise.all([
        db.select().from(staffShops).where(eq(staffShops.staffId, person.id)),
        db.select().from(staffSchedules).where(eq(staffSchedules.staffId, person.id)),
        db.select().from(shopHours),
        db.select().from(timeBlocks).where(and(eq(timeBlocks.staffId, person.id), gt(timeBlocks.endsAt, new Date()))).orderBy(asc(timeBlocks.startsAt)).limit(50),
      ])
    : [[], [], await db.select().from(shopHours), []];
  if (person && !ctx.isAdmin && !links.some((l) => ctx.shopIds.includes(l.shopId))) notFound();

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <PageHeader
        title={person ? person.displayLabel : "Add staff"}
        subtitle={
          person ? (
            <>
              {person.staffCode} · booking link slug <span className="font-mono">{person.publicSlug}</span> (first name only)
            </>
          ) : (
            "Staff ID and booking slug are generated automatically."
          )
        }
        actions={
          <Link className="text-sm underline" href="/admin/staff">
            All staff
          </Link>
        }
      />
      <ProfileForm
        isAdmin={ctx.isAdmin}
        shops={editableShops}
        allShops={allShops}
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
                role: person.role,
                managerShopId: person.managerShopId,
                isBookable: person.isBookable,
                active: person.active,
                squireName: person.squireName ?? "",
                shopIds: links.map((l) => l.shopId),
                hasLogin: !!person.passwordHash,
              }
            : null
        }
      />
      {person && (
        <>
          <ScheduleEditor
            staffId={person.id}
            shops={allShops.filter((s) => links.some((l) => l.shopId === s.id)).map((s) => ({ ...s, editable: editableShops.some((e) => e.id === s.id) }))}
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
    </div>
  );
}
