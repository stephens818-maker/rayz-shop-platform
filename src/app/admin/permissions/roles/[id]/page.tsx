import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { roles, staff } from "@/db/schema";
import { PageHeader } from "@/components/ui";
import { OWNER_ROLE_KEY, effectiveAccess, roleChangeDenied, templateFor, templateRow } from "@/domain/permissions";
import { guardPage, staffGrantor } from "@/server/auth/staff";
import { RoleEditor } from "./role-editor";

export const metadata: Metadata = { title: "Role" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function RolePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await guardPage("/admin/permissions/roles/[id]");
  const g = staffGrantor(ctx);
  const isNew = id === "new";
  if (!isNew && !UUID.test(id)) notFound();
  const role = isNew ? null : await db.query.roles.findFirst({ where: eq(roles.id, id) });
  if (!isNew && !role) notFound();
  const [{ n }] = role
    ? await db
        .select({ n: sql<number>`count(*)::int` })
        .from(staff)
        .where(sql`${staff.roleId} = ${role.id} or exists (select 1 from staff_access_shops a where a.staff_id = ${staff.id} and a.role_id = ${role.id})`)
    : [{ n: 0 }];
  const template = templateFor(role?.key);
  const readOnly = role?.key === OWNER_ROLE_KEY ? "The Brand Owner role always has every permission, including ones added later." : roleChangeDenied(g, null, { key: null, name: "x", permissions: [], maxDiscountPct: 0 });

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title={role ? role.name : "New custom role"}
        subtitle={
          <>
            <Link className="underline" href="/admin/permissions">
              Permissions
            </Link>{" "}
            · {role ? `${n} ${n === 1 ? "person" : "people"} · ${role.key ? "built-in template" : "custom role"}` : "Start from a template or from nothing"}
          </>
        }
      />
      <RoleEditor
        initial={
          role
            ? { id: role.id, key: role.key, name: role.name, description: role.description, permissions: [...effectiveAccess(role).permissions], maxDiscountPct: role.maxDiscountPct, defaultScope: role.defaultScope }
            : null
        }
        template={template ? { ...templateRow(template), permissions: [...effectiveAccess(template).permissions] } : null}
        starters={
          isNew
            ? (await db.select().from(roles).orderBy(roles.sortOrder))
                .filter((r) => r.key !== OWNER_ROLE_KEY)
                .map((r) => ({ name: r.name, permissions: [...effectiveAccess(r).permissions], maxDiscountPct: r.maxDiscountPct, defaultScope: r.defaultScope }))
            : []
        }
        mine={[...ctx.permissions]}
        myMaxDiscount={ctx.maxDiscountPct}
        people={n}
        readOnly={readOnly}
      />
    </div>
  );
}
