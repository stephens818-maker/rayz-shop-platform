import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { auditLog } from "@/db/schema";
import { Badge, Card, CardHeader, Notice, PageHeader } from "@/components/ui";
import { seesStaffContact } from "@/domain/staff-contact";
import { ACCOUNT_STATUS_LABEL, accountChangeDenied } from "@/domain/users";
import { formatDateTime } from "@/lib/time";
import { activeOwnerCount } from "@/server/auth/access";
import { guardPage, staffGrantor } from "@/server/auth/staff";
import { AppError } from "@/server/errors";
import { inTenant } from "@/server/tenant";
import { accountOf } from "@/server/users";
import { PersonAccessSection } from "../../permissions/people/[id]/access-section";
import { AccountControls, ProfileForm } from "../editor";

export const metadata: Metadata = { title: "User" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function UserPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await guardPage("/admin/users/[id]");
  if (!UUID.test(id) || !(await inTenant(ctx, "staff", id))) notFound();
  const account = await accountOf(ctx, id).catch((e) => {
    if (e instanceof AppError && e.code === "not_found") return null;
    throw e;
  });
  if (!account) notFound();
  const { row, access, target } = account;
  if (row.kind !== "person") notFound();
  const g = staffGrantor(ctx);
  const self = id === ctx.staff.id;
  const readOnly = self ? null : accountChangeDenied(g, target, "profile", { activeOwners: await activeOwnerCount() });
  const history = await db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.entityId, id), eq(auditLog.entity, "staff")))
    .orderBy(desc(auditLog.at))
    .limit(30);
  const removed = target.status === "removed";

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <PageHeader
        title={row.displayLabel}
        subtitle={
          <>
            <Link className="underline" href="/admin/users">
              Users
            </Link>{" "}
            · {access.role.name} · <Badge tone={removed ? "red" : target.status === "active" ? "green" : target.status === "invited" ? "blue" : "gray"}>{ACCOUNT_STATUS_LABEL[target.status]}</Badge>
            {row.lastSignInAt && <> · last signed in {formatDateTime(row.lastSignInAt)}</>}
          </>
        }
      />
      {removed ? (
        <Notice tone="red">Removed {row.removedAt ? formatDateTime(row.removedAt) : ""}. Their history stays; they can&apos;t sign in. Invite them again as a new user if they come back.</Notice>
      ) : (
        <>
          <Card>
            <CardHeader title="Profile" />
            <ProfileForm
              staffId={id}
              initial={{ firstName: row.firstName, lastName: row.lastName ?? "", displayLabel: row.displayLabel, email: seesStaffContact({ permissions: ctx.permissions, staffId: ctx.staff.id }, id) ? (row.email ?? "") : "" }}
              emailEditable={seesStaffContact({ permissions: ctx.permissions, staffId: ctx.staff.id }, id)}
              readOnly={!!readOnly}
            />
          </Card>
          <Card>
            <CardHeader title="Sign-in" subtitle={self ? "You can't deactivate or remove yourself, or turn off your own safeguards. Ask another admin." : undefined} />
            <AccountControls
              a={{
                staffId: id,
                label: row.displayLabel,
                status: target.status as "invited" | "active" | "deactivated",
                twoFactorRequired: row.twoFactorRequired,
                twoFactorOn: !!row.totpEnabledAt,
                remote: access.isOwner || access.permissions.has("access.remote"),
                readOnly,
                self,
                mayGiveRemote: g.permissions.has("access.remote"),
              }}
            />
          </Card>
          <div>
            <h2 className="mb-2 text-sm font-semibold text-zinc-700">Role, permissions and locations</h2>
            <PersonAccessSection ctx={ctx} target={access} />
          </div>
        </>
      )}
      {history.length > 0 && (
        <Card>
          <CardHeader title="Account history" subtitle="From the audit log." />
          <ul className="divide-y divide-zinc-100 text-xs text-zinc-600">
            {history.map((h) => (
              <li key={h.id} className="px-4 py-2">
                <span className="font-medium text-zinc-800">{h.action}</span> by {h.actorLabel} · {formatDateTime(h.at)}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
