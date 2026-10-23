import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { asc } from "drizzle-orm";
import { db } from "@/db";
import { roles, shops } from "@/db/schema";
import { PageHeader } from "@/components/ui";
import { cleanOverrides, staffEditDenied } from "@/domain/permissions";
import { accessState, loadStaffAccess, workShopIds } from "@/server/auth/access";
import { guardPage, staffGrantor } from "@/server/auth/staff";
import { OTHER_SHOP, hasShop, inTenant } from "@/server/tenant";
import { PersonAccessEditor } from "./person-editor";

export const metadata: Metadata = { title: "Access" };

export default async function PersonAccessPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await guardPage("/admin/permissions/people/[id]");
  if (!(await inTenant(ctx, "staff", id))) notFound();
  const target = await loadStaffAccess(id);
  if (!target) notFound();
  const works = await workShopIds(id);
  const person = (await db.query.staff.findFirst({ where: (s, { eq }) => eq(s.id, id) }))!;
  const [roleRows, allShops] = await Promise.all([db.select().from(roles).orderBy(asc(roles.sortOrder), asc(roles.name)), db
      .select({ id: shops.id, name: shops.name, status: shops.status })
      .from(shops)
      .orderBy(asc(shops.name))
      .then((rows) => rows.map((r) => ({ id: r.id, name: r.status === "archived" ? `${r.name} (archived)` : r.name }))),
  ]);
  const g = staffGrantor(ctx);
  const readOnly =
    id === ctx.staff.id
      ? "You can't change your own access. Ask another admin."
      : (staffEditDenied(g, { ...accessState(target), workShopIds: works }) ?? (target.isOwner && !ctx.isOwner ? "Only the Brand Owner can change a Brand Owner's access" : null));

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title={`${person.displayLabel}: access`}
        subtitle={
          <>
            <Link className="underline" href="/admin/permissions">
              Permissions
            </Link>{" "}
            ·{" "}
            <Link className="underline" href={`/admin/staff/${id}`}>
              Staff profile
            </Link>{" "}
            · {person.email ?? "no login"}
          </>
        }
      />
      <PersonAccessEditor
        staffId={id}
        initial={{
          roleId: target.role.id,
          overrides: cleanOverrides(person.permissionOverrides),
          maxDiscountPct: person.maxDiscountPct,
          scope: target.scope,
          shopIds: target.scope === "all" ? [] : target.shopIds,
          shopRoles: target.shopRoles,
        }}
        roles={roleRows.map((r) => ({ id: r.id, key: r.key, name: r.name, permissions: r.permissions, maxDiscountPct: r.maxDiscountPct, defaultScope: r.defaultScope }))}
        shops={ctx.brandWide ? allShops : allShops.filter((s) => hasShop(ctx, s.id))}
        worksAt={[...new Set(allShops.filter((s) => works.includes(s.id)).map((s) => (ctx.brandWide || hasShop(ctx, s.id) ? s.name : OTHER_SHOP)))]}
        mine={[...ctx.permissions]}
        myMaxDiscount={ctx.maxDiscountPct}
        iAmOwner={ctx.isOwner}
        iAmBrandWide={ctx.brandWide}
        readOnly={readOnly}
      />
    </div>
  );
}
