import type { Metadata } from "next";
import Link from "next/link";
import { asc, ne } from "drizzle-orm";
import { db } from "@/db";
import { roles, shops } from "@/db/schema";
import { Badge, Card, CardHeader, Empty, LinkButton, PageHeader, Table, Td, Th } from "@/components/ui";
import { OWNER_ROLE_KEY, assignableRoles, effectiveAccess } from "@/domain/permissions";
import { ACCOUNT_STATUS_LABEL } from "@/domain/users";
import { formatDateTime } from "@/lib/time";
import { guardPage, openShops, staffGrantor } from "@/server/auth/staff";
import { listUsers } from "@/server/users";
import { InviteForm } from "./editor";

export const metadata: Metadata = { title: "Users" };

const STATUS_TONE = { invited: "blue", active: "green", deactivated: "gray", removed: "red" } as const;

export default async function UsersPage() {
  const ctx = await guardPage("/admin/users");
  const g = staffGrantor(ctx);
  const [users, roleRows, shopRows] = await Promise.all([
    listUsers(ctx),
    db.select().from(roles).orderBy(asc(roles.sortOrder), asc(roles.name)),
    db.select({ id: shops.id, name: shops.name }).from(shops).where(ne(shops.status, "archived")).orderBy(asc(shops.name)),
  ]);
  const choices = assignableRoles(g, roleRows).filter((r) => ctx.brandWide || r.defaultScope !== "all");
  const where = (u: (typeof users)[number]) => (u.scope === "all" ? "All locations" : u.shops.map((s) => (ctx.brandWide || ctx.shopIds.includes(s.shopId) ? s.name : "another location")).join(", ") || "No locations");

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <PageHeader
        title="Users"
        subtitle="Everyone who signs in to the brand portal: invite them by email, give them a role and locations, fine-tune their permissions, and deactivate or remove them. Nobody can give more access than they have, and there's always a Brand Owner who can sign in. Every change is in the audit log."
        actions={
          <LinkButton variant="secondary" href="/admin/permissions">
            Roles and permissions
          </LinkButton>
        }
      />

      <Card>
        <CardHeader title="Invite a user" subtitle="They get an email with a link to set their password (and set up two-step sign-in if it's required). The link works once, for 7 days." />
        <InviteForm
          roles={choices.map((r) => ({ id: r.id, name: r.name, defaultScope: r.defaultScope, remote: r.key === OWNER_ROLE_KEY || effectiveAccess(r).permissions.has("access.remote") }))}
          shops={ctx.brandWide ? shopRows : openShops(ctx).map((s) => ({ id: s.id, name: s.name }))}
          brandWide={ctx.brandWide}
          mayGiveRemote={g.permissions.has("access.remote")}
        />
      </Card>

      <Card>
        <CardHeader title={`Users (${users.length})`} subtitle="Shop logins are under Setup → Shop logins." />
        {users.length === 0 ? (
          <Empty title="No users yet" />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>User</Th>
                <Th>Role</Th>
                <Th>Locations</Th>
                <Th>Status</Th>
                <Th>Two-step</Th>
                <Th>Remote</Th>
                <Th>Last sign-in</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <Td>
                    <div className="font-medium">{u.label}</div>
                    <div className="text-xs text-zinc-500">{u.email ?? "email hidden"}</div>
                  </Td>
                  <Td>
                    {u.role} {u.brandLevel && <Badge tone="violet">brand-level</Badge>}
                  </Td>
                  <Td className="max-w-56 whitespace-normal">{where(u)}</Td>
                  <Td>
                    <Badge tone={STATUS_TONE[u.status]}>{ACCOUNT_STATUS_LABEL[u.status]}</Badge>
                    {u.inviteExpires && <div className="text-[11px] text-zinc-500">link until {formatDateTime(u.inviteExpires)}</div>}
                  </Td>
                  <Td>{u.twoFactor === "on" ? <Badge tone="green">On</Badge> : u.twoFactor === "required" ? <Badge tone="amber">Required, not set up</Badge> : "Off"}</Td>
                  <Td>{u.remote ? "Yes" : "No"}</Td>
                  <Td>{u.lastSignInAt ? formatDateTime(u.lastSignInAt) : "Never"}</Td>
                  <Td right>
                    <Link className="text-sm underline" href={`/admin/users/${u.id}`}>
                      {u.id === ctx.staff.id ? "View" : "Manage"}
                    </Link>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Card>
        <CardHeader
          title="Role templates"
          subtitle="A role is a template of permissions across every module (reports, Campaign Center, client fields and exports, inventory and purchase orders, settings, staff, payroll and time clock, tip payouts, banking and Stripe, Rayz Assistant, the locations wizard). Edit the built-in ones or create your own; each user can then have permissions added or taken away on top."
          action={
            ctx.brandWide ? (
              <LinkButton size="sm" variant="dark" href="/admin/permissions/roles/new">
                New role
              </LinkButton>
            ) : undefined
          }
        />
        <ul className="divide-y divide-zinc-100 text-sm">
          {roleRows.map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-3 px-4 py-2">
              <span>
                <span className="font-medium">{r.name}</span> {!r.key && <Badge tone="blue">custom</Badge>}
                <span className="ml-2 text-xs text-zinc-500">{r.key === OWNER_ROLE_KEY ? "every permission" : `${effectiveAccess(r).permissions.size} permissions`}</span>
              </span>
              <Link className="text-xs underline" href={`/admin/permissions/roles/${r.id}`}>
                {r.key === OWNER_ROLE_KEY || !ctx.brandWide ? "View" : "Edit"}
              </Link>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
