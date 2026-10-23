import type { Metadata } from "next";
import { eq } from "drizzle-orm";
import { Card, CardHeader, PageHeader } from "@/components/ui";
import { db } from "@/db";
import { roles, staff, staffAccessShops } from "@/db/schema";
import { guardPage } from "@/server/auth/staff";
import { buildDigest, loadDigestSettings } from "@/server/digest";
import { DigestEditor, type DigestPerson } from "./editor";

export const metadata: Metadata = { title: "Morning digest" };

export default async function DigestPage() {
  const ctx = await guardPage("/admin/digest");
  const settings = await loadDigestSettings();
  const [roleRows, people, shopRoles, preview] = await Promise.all([
    db.select({ key: roles.key, name: roles.name }).from(roles).orderBy(roles.sortOrder, roles.name),
    db
      .select({ id: staff.id, label: staff.displayLabel, email: staff.email, role: roles.name, roleKey: roles.key })
      .from(staff)
      .innerJoin(roles, eq(roles.id, staff.roleId))
      .where(eq(staff.active, true))
      .orderBy(staff.displayLabel),
    db.select({ staffId: staffAccessShops.staffId, key: roles.key }).from(staffAccessShops).innerJoin(roles, eq(roles.id, staffAccessShops.roleId)),
    buildDigest(ctx.staff.id, new Date(), settings),
  ]);
  const list: DigestPerson[] = people.map((p) => ({
    id: p.id,
    label: p.label,
    email: p.email,
    role: p.role,
    roleKeys: [p.roleKey, ...shopRoles.filter((r) => r.staffId === p.id).map((r) => r.key)].filter((k): k is string => !!k),
  }));
  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <PageHeader
        title="Morning digest"
        subtitle="A short email to the owner and managers before the shops open: yesterday's sales, today's team, and what needs attention. Each person's copy covers only their shops."
      />
      <div className="grid gap-4 lg:grid-cols-[1fr_24rem]">
        <DigestEditor initial={settings} roles={roleRows.filter((r): r is { key: string; name: string } => !!r.key)} people={list} />
        <Card className="self-start">
          <CardHeader title="Your copy, right now" subtitle={preview ? preview.subject : "You have no open shops, so you wouldn't get one."} />
          {preview && <pre className="max-h-[40rem] overflow-auto whitespace-pre-wrap p-4 font-sans text-xs text-zinc-800">{preview.body}</pre>}
        </Card>
      </div>
    </div>
  );
}
