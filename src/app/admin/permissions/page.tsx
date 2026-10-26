import type { Metadata } from "next";
import Link from "next/link";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { roles, shops, staff, staffAccessShops } from "@/db/schema";
import { Badge, Card, CardHeader, LinkButton, PageHeader, Table, Td, Th } from "@/components/ui";
import { OWNER_ROLE_KEY, SCOPE_LABEL, cleanExpiries, cleanLimits, cleanOverrides, effectiveAccess, liveOverrides } from "@/domain/permissions";
import { todayLocal } from "@/lib/time";
import { seesStaffContact, staffContact } from "@/domain/staff-contact";
import { guardPage } from "@/server/auth/staff";
import { OTHER_SHOP, hasShop } from "@/server/tenant";

export const metadata: Metadata = { title: "Permissions" };

export default async function PermissionsPage() {
  const ctx = await guardPage("/admin/permissions");
  const [roleRows, people, access] = await Promise.all([
    db.select().from(roles).orderBy(asc(roles.sortOrder), asc(roles.name)),
    db
      .select({ s: staff, role: roles })
      .from(staff)
      .innerJoin(roles, eq(roles.id, staff.roleId))
      .where(eq(staff.active, true))
      .orderBy(asc(roles.sortOrder), asc(staff.displayLabel)),
    db.select({ staffId: staffAccessShops.staffId, name: shops.name, shopId: shops.id, roleId: staffAccessShops.roleId }).from(staffAccessShops).innerJoin(shops, eq(shops.id, staffAccessShops.shopId)),
  ]);
  const viewer = { permissions: ctx.permissions, staffId: ctx.staff.id };
  const today = todayLocal();
  const shopsOf = (id: string) => access.filter((a) => a.staffId === id);
  const visible = people.filter(({ s, role }) => ctx.brandWide || (s.shopScope !== "all" && role.key !== OWNER_ROLE_KEY && shopsOf(s.id).some((a) => ctx.shopIds.includes(a.shopId))));

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Permissions"
        subtitle="Roles are editable templates. Each person gets a role, optional per-person overrides (with an end date if they're temporary), and access to all shops, a region's or an owner's shops, selected shops or one shop, with a different role at some shops if needed. Every change is in the audit log."
        actions={
          <div className="flex flex-wrap gap-2">
            <LinkButton href="/admin/permissions/matrix" variant="secondary">
              Permissions matrix
            </LinkButton>
            <LinkButton href="/admin/permissions/view-as" variant="secondary">
              View as
            </LinkButton>
            {ctx.brandWide && (
              <LinkButton href="/admin/permissions/roles/new" variant="dark">
                New custom role
              </LinkButton>
            )}
          </div>
        }
      />
      <Card>
        <CardHeader title="Roles" subtitle={ctx.brandWide ? "Changes apply to everyone with the role straight away." : "Roles apply at every shop, so only people with access to all shops can edit them."} />
        <Table>
          <thead>
            <tr>
              <Th>Role</Th>
              <Th>Default access</Th>
              <Th right>Permissions</Th>
              <Th right>Discount limit</Th>
              <Th right>People</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {roleRows.map((r) => {
              const a = effectiveAccess(r);
              const n = people.filter((p) => p.role.id === r.id).length;
              return (
                <tr key={r.id}>
                  <Td>
                    <div className="font-medium">
                      {r.name} {!r.key && <Badge tone="blue">custom</Badge>}
                    </div>
                    <div className="max-w-md whitespace-normal text-xs text-zinc-500">{r.description}</div>
                  </Td>
                  <Td>{SCOPE_LABEL[r.defaultScope]}</Td>
                  <Td right>{r.key === OWNER_ROLE_KEY ? "All" : a.permissions.size}</Td>
                  <Td right>{a.permissions.has("pos.discount") ? `${a.maxDiscountPct}%` : "None"}</Td>
                  <Td right>{n}</Td>
                  <Td right>
                    <span className="flex justify-end gap-3 text-sm">
                      <Link className="underline" href={`/admin/permissions/view-as?as=role:${r.id}`}>
                        View as
                      </Link>
                      {ctx.brandWide && r.key !== OWNER_ROLE_KEY && (
                        <Link className="underline" href={`/admin/permissions/roles/new?from=${r.id}`}>
                          Clone
                        </Link>
                      )}
                      <Link className="underline" href={`/admin/permissions/roles/${r.id}`}>
                        {r.key === OWNER_ROLE_KEY || !ctx.brandWide ? "View" : "Edit"}
                      </Link>
                    </span>
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      </Card>

      <Card className="mt-4">
        <CardHeader title="People" subtitle="Role, overrides and shop access per person." />
        <Table>
          <thead>
            <tr>
              <Th>Person</Th>
              <Th>Role</Th>
              <Th>Shop access</Th>
              <Th right>Overrides</Th>
              <Th right>Discount limit</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {visible.map(({ s, role }) => {
              const ends = cleanExpiries(s.permissionOverrideExpires);
              const o = liveOverrides(cleanOverrides(s.permissionOverrides), ends, today);
              const scope = role.key === OWNER_ROLE_KEY ? "all" : s.shopScope;
              const a = effectiveAccess(role, o, s.maxDiscountPct, scope, cleanLimits(s.moneyLimits));
              const temporary = Object.keys(o).filter((p) => p in ends).length;
              return (
                <tr key={s.id}>
                  <Td>
                    <div className="font-medium">{s.displayLabel}</div>
                    <div className="text-xs text-zinc-500">{staffContact(seesStaffContact(viewer, s.id), s).email ?? "no login"}</div>
                  </Td>
                  <Td>
                    {role.name} {s.kind === "shop" && <Badge tone="violet">shop login</Badge>}
                  </Td>
                  <Td>{scope === "all" ? "All shops" : [
                        ...new Set(
                          shopsOf(s.id).map((x) =>
                            ctx.brandWide || hasShop(ctx, x.shopId) ? `${x.name}${x.roleId && x.roleId !== role.id ? ` (${roleRows.find((r) => r.id === x.roleId)?.name})` : ""}` : OTHER_SHOP,
                          ),
                        ),
                      ].join(", ") || <span className="text-red-600">No shops</span>}</Td>
                  <Td right>
                    {Object.keys(o).length || "—"}
                    {temporary > 0 && <span className="block text-xs text-zinc-500">{temporary} temporary</span>}
                  </Td>
                  <Td right>{a.permissions.has("pos.discount") ? `${a.maxDiscountPct}%${s.maxDiscountPct !== null ? " (own)" : ""}` : "None"}</Td>
                  <Td right>
                    <span className="flex justify-end gap-3 text-sm">
                      <Link className="underline" href={`/admin/permissions/view-as?as=staff:${s.id}`}>
                        View as
                      </Link>
                      <Link className="underline" href={`/admin/permissions/people/${s.id}`}>
                        {s.id === ctx.staff.id || (role.key === OWNER_ROLE_KEY && !ctx.isOwner) ? "View" : "Edit"}
                      </Link>
                    </span>
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
