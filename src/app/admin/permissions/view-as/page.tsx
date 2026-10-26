import type { Metadata } from "next";
import Link from "next/link";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { roles, shops, staff } from "@/db/schema";
import { AccessBreakdown, BreakdownColumn } from "@/components/access-breakdown";
import { Badge, Button, Card, CardHeader, Empty, Notice, PageHeader, Select } from "@/components/ui";
import { LEVEL_LABEL } from "@/domain/client-privacy";
import { navFor, reportsFor } from "@/domain/navigation";
import { MONEY_LIMITS, OWNER_ROLE_KEY, Permission, SCOPE_LABEL, cleanExpiries, cleanOverrides, isBrandLevelPerson, limitLabel, liveOverrides, roleFitsShop } from "@/domain/permissions";
import { todayLocal } from "@/lib/time";
import { atShop, loadStaffAccess, roleAccessAt } from "@/server/auth/access";
import { breakdownColumns, column } from "@/server/auth/breakdown";
import { guardPage } from "@/server/auth/staff";
import { clientViewPreview } from "@/server/client-privacy";
import { hasShop, inTenant } from "@/server/tenant";

export const metadata: Metadata = { title: "View as" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LEVEL_TONE = { full: "green", masked: "amber", hidden: "gray" } as const;

/** Exactly what a role, or one person, sees: their menu, reports, limits, client details and every permission by area. */
export default async function ViewAsPage({ searchParams }: { searchParams: Promise<{ as?: string; shop?: string }> }) {
  const ctx = await guardPage("/admin/permissions/view-as");
  const sp = await searchParams;
  const [kind, id] = (sp.as ?? "").split(":");
  const shopId = sp.shop && UUID.test(sp.shop) && (ctx.brandWide || hasShop(ctx, sp.shop)) ? sp.shop : null;
  const [roleRows, people, shopRows] = await Promise.all([
    db.select().from(roles).orderBy(asc(roles.sortOrder), asc(roles.name)),
    db
      .select({ id: staff.id, label: staff.displayLabel, kind: staff.kind, scope: staff.shopScope, roleKey: roles.key })
      .from(staff)
      .innerJoin(roles, eq(roles.id, staff.roleId))
      .where(eq(staff.active, true))
      .orderBy(asc(staff.displayLabel)),
    db.select({ id: shops.id, name: shops.name, ownerEntityId: shops.ownerEntityId }).from(shops).orderBy(asc(shops.name)),
  ]);
  const myShops = shopRows.filter((s) => ctx.brandWide || hasShop(ctx, s.id));
  const visiblePeople = ctx.brandWide ? people : people.filter((p) => p.scope !== "all" && p.roleKey !== OWNER_ROLE_KEY);
  const shopName = (sid: string | null) => (sid ? (shopRows.find((s) => s.id === sid)?.name ?? "Shop") : null);

  let preview: {
    title: string;
    sub: string;
    edit: string;
    perms: ReadonlySet<Permission>;
    columns: BreakdownColumn[];
    overrides?: Record<string, boolean>;
    expires?: Record<string, string>;
    client: Awaited<ReturnType<typeof clientViewPreview>>;
    exportsClients: boolean;
    limits: BreakdownColumn;
  } | null = null;
  let problem: string | null = null;

  if (kind === "role" && id && UUID.test(id)) {
    const role = roleRows.find((r) => r.id === id);
    if (!role) problem = "That role is gone.";
    else {
      const a = await roleAccessAt(role, shopId);
      const owner = shopRows.find((s) => s.id === shopId)?.ownerEntityId;
      const brandLevel = isBrandLevelPerson({ kind: "person", scope: a.scope, role });
      const col = column("role", shopName(shopId) ?? "Every shop", a, role, { scope: a.scope, kind: "person", ownerMismatch: !!shopId && !roleFitsShop(role, owner) });
      preview = {
        title: role.name,
        sub: `${role.key ? "Built-in role" : "Custom role"} with its default shop access (${SCOPE_LABEL[role.defaultScope].toLowerCase()}) and no per-person overrides${shopId ? `, at ${shopName(shopId)}` : ""}.`,
        edit: `/admin/permissions/roles/${role.id}`,
        perms: a.permissions,
        columns: [col],
        client: await clientViewPreview({ staffId: null, roleId: role.id, roleKey: role.key, shopId, isOwner: a.isOwner, brandLevel, shopLogin: false, grantedContact: false, canReveal: a.permissions.has("clients.reveal") }),
        exportsClients: a.isOwner || brandLevel,
        limits: col,
      };
    }
  } else if (kind === "staff" && id && UUID.test(id)) {
    const person = await db.query.staff.findFirst({ where: eq(staff.id, id) });
    const full = person && (await inTenant(ctx, "staff", id)) ? await loadStaffAccess(id) : null;
    if (!person || !full) problem = "That person isn't on your shops' team.";
    else {
      const here = shopId && full.byShop.has(shopId) ? atShop(full, shopId) : null;
      if (shopId && !here) problem = `${person.displayLabel} has no access at ${shopName(shopId)}, so they see nothing there.`;
      const a = here ?? full;
      const roleHere = (shopId && full.byShop.get(shopId)?.role) || full.role;
      const brandLevel = isBrandLevelPerson({ kind: person.kind, scope: full.scope, role: full.role });
      const expires = cleanExpiries(person.permissionOverrideExpires);
      const overrides = liveOverrides(cleanOverrides(person.permissionOverrides), expires, todayLocal()) as Record<string, boolean>;
      const columns = here
        ? [column(shopId!, shopName(shopId)!, here, roleHere, { scope: full.scope, kind: person.kind, granted: full.granted, ownerMismatch: !roleFitsShop(roleHere, shopRows.find((s) => s.id === shopId)?.ownerEntityId) })]
        : await breakdownColumns(full, person.kind, (sid) => ctx.brandWide || hasShop(ctx, sid));
      preview = {
        title: person.displayLabel,
        sub: `${roleHere.name}${person.kind === "shop" ? " (shared shop login)" : ""} · ${SCOPE_LABEL[full.scope]}${here ? ` · at ${shopName(shopId)}` : full.uniform ? "" : " · a different role at some shops: each column is what they can do there"}`,
        edit: `/admin/permissions/people/${id}`,
        perms: a.permissions,
        columns,
        overrides,
        expires: Object.fromEntries(Object.entries(expires).filter(([p]) => p in overrides)),
        client: await clientViewPreview({
          staffId: id,
          roleId: roleHere.id,
          roleKey: roleHere.key,
          shopId,
          isOwner: a.isOwner,
          brandLevel,
          shopLogin: person.kind === "shop",
          grantedContact: !brandLevel && a.permissions.has("clients.contact_full") && full.granted.has("clients.contact_full"),
          canReveal: a.permissions.has("clients.reveal"),
        }),
        exportsClients: a.isOwner || brandLevel || (a.permissions.has("clients.export") && full.granted.has("clients.export")),
        limits: column("limits", "", a, roleHere, { scope: full.scope, kind: person.kind }),
      };
    }
  }

  const nav = preview ? navFor(preview.perms) : [];
  const reports = preview ? reportsFor(preview.perms) : [];

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="View as"
        subtitle={
          <>
            <Link className="underline" href="/admin/permissions">
              Permissions
            </Link>{" "}
            · See exactly what a role or one person can open and do, shop by shop. Nothing here changes their access.
          </>
        }
      />
      <Card className="mb-4">
        <form className="flex flex-wrap items-end gap-3 p-4" method="get">
          <label className="text-sm">
            <span className="mb-1 block text-xs font-medium text-zinc-600">Role or person</span>
            <Select name="as" defaultValue={sp.as ?? ""} className="w-72" aria-label="Role or person">
              <option value="">Pick one</option>
              <optgroup label="Roles">
                {roleRows.map((r) => (
                  <option key={r.id} value={`role:${r.id}`}>
                    {r.name}
                    {r.key ? "" : " (custom)"}
                  </option>
                ))}
              </optgroup>
              <optgroup label="People">
                {visiblePeople.map((p) => (
                  <option key={p.id} value={`staff:${p.id}`}>
                    {p.label}
                    {p.kind === "shop" ? " (shop login)" : ""}
                  </option>
                ))}
              </optgroup>
            </Select>
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-xs font-medium text-zinc-600">At</span>
            <Select name="shop" defaultValue={shopId ?? ""} className="w-56" aria-label="Shop">
              <option value="">{ctx.brandWide ? "Every shop" : "All their shops"}</option>
              {myShops.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </label>
          <Button type="submit" variant="dark">
            Show
          </Button>
        </form>
      </Card>

      {problem && (
        <div className="mb-4">
          <Notice tone="amber">{problem}</Notice>
        </div>
      )}
      {!preview ? (
        !problem && <Empty title="Pick a role or a person">Their menu, reports, dollar limits, what they see of clients and every permission by area.</Empty>
      ) : (
        <div className="space-y-4" data-testid="view-as">
          <Card className="p-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <div className="text-lg font-semibold">Viewing as {preview.title}</div>
                <div className="text-sm text-zinc-500">{preview.sub}</div>
              </div>
              <Link className="text-sm underline" href={preview.edit}>
                Change their access
              </Link>
            </div>
          </Card>
          <div className="grid gap-4 lg:grid-cols-3">
            <Card>
              <CardHeader title="Their menu" subtitle={`${nav.reduce((n, s) => n + s.items.length, 0)} pages. Pages they can't open aren't listed, and the server refuses them.`} />
              <div className="max-h-[28rem] space-y-3 overflow-auto p-4 text-sm" data-testid="view-as-nav">
                {nav.length === 0 && <p className="text-zinc-500">Nothing: they can only sign in.</p>}
                {nav.map((s) => (
                  <div key={s.title}>
                    <div className="text-xs font-semibold uppercase tracking-wide text-zinc-500">{s.title}</div>
                    <ul className="mt-1 space-y-0.5">
                      {s.items.map((i) => (
                        <li key={i.href}>{i.label}</li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </Card>
            <Card>
              <CardHeader title="Reports" subtitle={`${reports.length} reports, ${reports.filter((r) => r.canExport).length} with export.`} />
              <ul className="max-h-[28rem] divide-y divide-zinc-100 overflow-auto text-sm" data-testid="view-as-reports">
                {reports.length === 0 && <li className="px-4 py-3 text-zinc-500">None.</li>}
                {reports.map((r) => (
                  <li key={r.key} className="flex items-center justify-between px-4 py-1.5">
                    {r.label}
                    {r.canExport ? <Badge tone="green">export</Badge> : <Badge>view</Badge>}
                  </li>
                ))}
              </ul>
            </Card>
            <Card>
              <CardHeader title="Clients" subtitle="What they see of a client's record. Reveals and contact views are logged." />
              <ul className="divide-y divide-zinc-100 text-sm" data-testid="view-as-client">
                {preview.client.map((f) => (
                  <li key={f.field} className="flex items-center justify-between px-4 py-1.5" data-field={f.field}>
                    {f.label}
                    <span className="flex items-center gap-1.5">
                      {f.reveal && <span className="text-xs text-zinc-500">reveal</span>}
                      <Badge tone={LEVEL_TONE[f.level]}>{LEVEL_LABEL[f.level]}</Badge>
                    </span>
                  </li>
                ))}
                <li className="flex items-center justify-between px-4 py-1.5">
                  Export the client list
                  <Badge tone={preview.exportsClients ? "green" : "gray"}>{preview.exportsClients ? "Yes" : "No"}</Badge>
                </li>
              </ul>
              <div className="border-t border-zinc-100 px-4 py-3 text-sm">
                <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-zinc-500">Limits</div>
                {preview.limits.isOwner ? (
                  "No limits"
                ) : (
                  <ul className="space-y-0.5" data-testid="view-as-limits">
                    <li>Manual discount: {preview.perms.has("pos.discount") ? `${preview.limits.maxDiscountPct}% and ${limitLabel(preview.limits.limits.discountCents)}` : "none"}</li>
                    {MONEY_LIMITS.filter((l) => l.key !== "discountCents").map((l) => (
                      <li key={l.key}>
                        {l.label}: {l.perms.some((p) => preview!.perms.has(p)) ? limitLabel(preview!.limits.limits[l.key]) : l.key === "refundCents" ? "none (a manager's PIN)" : "none"}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </Card>
          </div>
          <AccessBreakdown columns={preview.columns} overrides={preview.overrides} expires={preview.expires} title="Every permission, by area" />
        </div>
      )}
    </div>
  );
}
