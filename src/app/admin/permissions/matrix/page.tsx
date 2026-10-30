import type { Metadata } from "next";
import Link from "next/link";
import { asc, sql } from "drizzle-orm";
import { db } from "@/db";
import { roles, staff } from "@/db/schema";
import { PageHeader } from "@/components/ui";
import { OWNER_ROLE_KEY, cleanLimits, effectiveAccess, isBrandLevelRole, roleChangeDenied } from "@/domain/permissions";
import { guardPage, staffGrantor } from "@/server/auth/staff";
import { RoleMatrix } from "./role-matrix";

export const metadata: Metadata = { title: "Permissions matrix" };

export default async function PermissionsMatrixPage() {
  const ctx = await guardPage("/admin/permissions/matrix");
  const g = staffGrantor(ctx);
  const [roleRows, counts] = await Promise.all([
    db.select().from(roles).orderBy(asc(roles.sortOrder), asc(roles.name)),
    db.execute<{ role_id: string; n: number }>(sql`
      select r.id as role_id, count(distinct s.id)::int as n
      from ${roles} r
      join ${staff} s on s.active and s.removed_at is null and (s.role_id = r.id or exists (select 1 from staff_access_shops a where a.staff_id = s.id and a.role_id = r.id))
      group by r.id`),
  ]);
  const people = new Map([...counts].map((c) => [c.role_id, c.n]));
  const readOnly = roleChangeDenied(g, null, { key: null, name: "x", permissions: [], maxDiscountPct: 0 });

  return (
    <div className="mx-auto max-w-[96rem]">
      <PageHeader
        title="Permissions matrix"
        subtitle={
          <>
            <Link className="underline" href="/admin/permissions">
              Permissions
            </Link>{" "}
            · Every role against every permission, area by area. Pick a level in a cell to change the role; saving sends it through the brand change scope, so you pick which shops get it.{" "}
            <Link className="underline" href="/admin/permissions/view-as">
              View as a role or person
            </Link>
          </>
        }
      />
      <RoleMatrix
        roles={roleRows.map((r) => ({
          id: r.id,
          key: r.key,
          name: r.name,
          description: r.description,
          permissions: [...effectiveAccess(r).permissions],
          maxDiscountPct: r.maxDiscountPct,
          defaultScope: r.defaultScope,
          moneyLimits: cleanLimits(r.moneyLimits),
          brandLevel: r.brandLevel,
          isBrandLevel: isBrandLevelRole(r),
          isOwnerRole: r.key === OWNER_ROLE_KEY,
          people: people.get(r.id) ?? 0,
        }))}
        mine={[...g.permissions]}
        isOwner={ctx.isOwner}
        readOnly={readOnly}
      />
    </div>
  );
}
