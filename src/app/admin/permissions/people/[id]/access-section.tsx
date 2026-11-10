import Link from "next/link";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { regions, roles, shops, staff } from "@/db/schema";
import { AccessBreakdown } from "@/components/access-breakdown";
import { Notice } from "@/components/ui";
import { CONTACT_GRANT_LABEL, ContactGrantKind } from "@/domain/contact-grants";
import { NO_LIMITS, cleanExpiries, cleanLimits, cleanOverrides, liveOverrides, staffEditDenied } from "@/domain/permissions";
import { todayLocal } from "@/lib/time";
import { StaffAccess, accessState, workShopIds } from "@/server/auth/access";
import { breakdownColumns } from "@/server/auth/breakdown";
import { StaffContext, staffGrantor } from "@/server/auth/staff";
import { OTHER_SHOP, hasShop } from "@/server/tenant";
import { entityChoices } from "@/server/owner-entities";
import { PersonAccessEditor } from "./person-editor";

/** One person's role, à la carte permissions and locations, with any contact access the brand gave them. Used on Permissions and on Users. */
export async function PersonAccessSection({ ctx, target }: { ctx: StaffContext; target: StaffAccess }) {
  const id = target.staffId;
  const [works, person, roleRows, allShops, entities, regionRows] = await Promise.all([
    workShopIds(id),
    db.query.staff.findFirst({ where: eq(staff.id, id) }).then((p) => p!),
    db.select().from(roles).orderBy(asc(roles.sortOrder), asc(roles.name)),
    db
      .select({ id: shops.id, name: shops.name, status: shops.status, ownerEntityId: shops.ownerEntityId, regionId: shops.regionId })
      .from(shops)
      .orderBy(asc(shops.name))
      .then((rows) => rows.map((r) => ({ id: r.id, ownerEntityId: r.ownerEntityId, regionId: r.regionId, name: r.status === "archived" ? `${r.name} (archived)` : r.name }))),
    entityChoices(ctx),
    db.select({ id: regions.id, name: regions.name }).from(regions).orderBy(asc(regions.name)),
  ]);
  const g = staffGrantor(ctx);
  const readOnly =
    id === ctx.staff.id
      ? "You can't change your own access. Ask another admin."
      : (staffEditDenied(g, { ...accessState(target), workShopIds: works }) ?? (target.isOwner && !ctx.isOwner ? "Only the Brand Owner can change a Brand Owner's access" : null));

  const shopName = (sid: string) => allShops.find((s) => s.id === sid)?.name ?? OTHER_SHOP;
  const contactAccess = [
    ...[...target.grants.everywhere].map((k) => ({ k, where: "everywhere" })),
    ...[...target.grants.byShop].flatMap(([sid, ks]) => [...ks].filter((k) => !target.grants.everywhere.has(k)).map((k) => ({ k, where: `at ${shopName(sid)}` }))),
  ] as { k: ContactGrantKind; where: string }[];
  const expires = cleanExpiries(person.permissionOverrideExpires);
  const overrides = liveOverrides(cleanOverrides(person.permissionOverrides), expires, todayLocal());
  const liveExpires = Object.fromEntries(Object.entries(expires).filter(([p]) => p in overrides));
  // Below brand level, only a whole region the caller is over.
  const regionChoices = ctx.brandWide ? regionRows : regionRows.filter((r) => ctx.scope === "region" && ctx.scopeRegionId === r.id);
  const columns = await breakdownColumns(target, person.kind, (sid) => ctx.brandWide || hasShop(ctx, sid));

  return (
    <>
      {contactAccess.length > 0 && (
        <div className="mb-4">
          <Notice tone="blue">
            Contact access from the brand: {contactAccess.map((c) => `${CONTACT_GRANT_LABEL[c.k].toLowerCase()} ${c.where}`).join("; ")}. It&apos;s managed under{" "}
            <Link className="underline" href="/admin/client-data/contact-access">
              Contact access
            </Link>
            , not here.
          </Notice>
        </div>
      )}
      <PersonAccessEditor
        staffId={id}
        initial={{
          roleId: target.role.id,
          overrides,
          expires: liveExpires,
          maxDiscountPct: person.maxDiscountPct,
          moneyLimits: cleanLimits(person.moneyLimits),
          scope: target.scope,
          scopeEntityId: target.scopeEntityId,
          scopeRegionId: target.scopeRegionId,
          shopIds: target.scope === "all" ? [] : target.shopIds,
          shopRoles: target.shopRoles,
        }}
        roles={roleRows.map((r) => ({
          id: r.id,
          key: r.key,
          name: r.name,
          permissions: r.permissions,
          maxDiscountPct: r.maxDiscountPct,
          defaultScope: r.defaultScope,
          brandLevel: r.brandLevel,
          moneyLimits: cleanLimits(r.moneyLimits),
          ownerEntityId: r.ownerEntityId,
        }))}
        shops={ctx.brandWide ? allShops : allShops.filter((s) => hasShop(ctx, s.id))}
        entities={entities}
        regions={regionChoices}
        worksAt={[...new Set(allShops.filter((s) => works.includes(s.id)).map((s) => (ctx.brandWide || hasShop(ctx, s.id) ? s.name : OTHER_SHOP)))]}
        mine={[...g.permissions]}
        myMaxDiscount={ctx.maxDiscountPct}
        myLimits={g.limits ?? NO_LIMITS}
        iAmOwner={ctx.isOwner}
        iAmBrandWide={ctx.brandWide}
        readOnly={readOnly}
        kind={person.kind}
      />
      <div className="mt-4" id="effective">
        <AccessBreakdown
          columns={columns}
          overrides={overrides}
          expires={liveExpires}
          subtitle="What they can do now, as saved, at each of their shops. Click a row for each permission and where it comes from: the role, an override for them (and when it ends), a contact access grant, or the rule that keeps it off."
        />
      </div>
    </>
  );
}
