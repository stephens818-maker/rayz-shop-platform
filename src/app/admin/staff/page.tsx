import type { Metadata } from "next";
import Link from "next/link";
import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { roles, shops, staff, staffSchedules, staffShops } from "@/db/schema";
import { Badge, Card, LinkButton, PageHeader, Table, Td, Th } from "@/components/ui";
import { can, guardPage } from "@/server/auth/staff";
import { hasShop, inShops } from "@/server/tenant";

export const metadata: Metadata = { title: "Staff" };

export default async function StaffPage({ searchParams }: { searchParams: Promise<{ inactive?: string }> }) {
  const sp = await searchParams;
  const ctx = await guardPage("/admin/staff");
  const links = await db
    .select({ staffId: staffShops.staffId, shopId: staffShops.shopId, shop: shops.name })
    .from(staffShops)
    .innerJoin(shops, eq(shops.id, staffShops.shopId))
    .orderBy(asc(shops.name));
  const scopeIds = ctx.currentShopId ? [ctx.currentShopId] : ctx.shopIds;
  const visible = new Set(links.filter((l) => scopeIds.includes(l.shopId)).map((l) => l.staffId));
  const all = await db.select({ s: staff, role: roles.name }).from(staff).innerJoin(roles, eq(roles.id, staff.roleId)).orderBy(asc(staff.displayLabel));
  const roleOf = new Map(all.map((r) => [r.s.id, r.role]));
  const people = all
    .map((r) => r.s)
    .filter((s) => s.kind === "person" && !s.removedAt && (visible.has(s.id) || (ctx.brandWide && !ctx.currentShopId)) && (sp.inactive || s.active));
  const scheds = people.length
    ? await db
        .select()
        .from(staffSchedules)
        .where(and(inArray(staffSchedules.staffId, people.map((p) => p.id)), ctx.brandWide ? undefined : inShops(ctx, staffSchedules.shopId)))
    : [];
  const shopName = ctx.currentShopId ? ctx.shops.find((s) => s.id === ctx.currentShopId)?.name : "All shops";

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Staff & schedules"
        subtitle={`${shopName} · ${people.length} people. Customers only ever see the display label; last names stay private.${can(ctx, "logins.manage") ? " Shared front-desk logins are under Shop logins." : ""}`}
        actions={
          <>
            <Link className="text-sm underline" href={sp.inactive ? "/admin/staff" : "/admin/staff?inactive=1"}>
              {sp.inactive ? "Hide inactive" : "Show inactive"}
            </Link>
            {(can(ctx, "staff.manage") || can(ctx, "schedules.edit")) && (
              <LinkButton href={`/admin/bulk-edit?tab=${can(ctx, "staff.manage") ? "staff" : "schedules"}`} variant="secondary">
                Bulk edit
              </LinkButton>
            )}
            {can(ctx, "staff.manage") && <LinkButton href="/admin/staff/new">Add staff</LinkButton>}
          </>
        }
      />
      <Card>
        <Table>
          <thead>
            <tr>
              <Th>Staff ID</Th>
              <Th>Display label</Th>
              <Th>Role</Th>
              <Th>Shops</Th>
              <Th>Weekly hours</Th>
              <Th>Status</Th>
            </tr>
          </thead>
          <tbody>
            {people.map((p) => {
              const mine = scheds.filter((s) => s.staffId === p.id);
              const hrs = mine.reduce((a, s) => a + (s.endMin - s.startMin), 0) / 60;
              const theirShops = links.filter((l) => l.staffId === p.id);
              const myShops = ctx.brandWide ? theirShops : theirShops.filter((l) => hasShop(ctx, l.shopId));
              const away = theirShops.length - myShops.length;
              return (
                <tr key={p.id} className="hover:bg-zinc-50">
                  <Td className="font-mono text-xs">{p.staffCode}</Td>
                  <Td>
                    <Link href={`/admin/staff/${p.id}`} className="flex items-center gap-2 font-medium hover:underline">
                      <span className="h-2.5 w-2.5 rounded-full" style={{ background: p.color }} />
                      {p.displayLabel}
                    </Link>
                  </Td>
                  <Td>{roleOf.get(p.id)}</Td>
                  <Td className="whitespace-normal">
                    {myShops.map((l) => (
                      <span key={l.shopId} className="mr-1 inline-block">
                        <Badge tone={theirShops.length > 1 ? "violet" : "gray"}>{l.shop}</Badge>
                      </span>
                    ))}
                    {away > 0 && <span className="text-xs text-zinc-500">+{away === 1 ? "another shop" : `${away} other shops`}</span>}
                  </Td>
                  <Td className="tabular">{hrs ? `${hrs.toFixed(hrs % 1 ? 1 : 0)} h · ${new Set(mine.map((m) => m.weekday)).size} days` : <span className="text-zinc-400">No hours</span>}</Td>
                  <Td>
                    {!p.active ? <Badge>Inactive</Badge> : !p.isBookable ? <Badge tone="amber">Not bookable</Badge> : <Badge tone="green">Bookable</Badge>}
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      </Card>
    </div>
  );
}
