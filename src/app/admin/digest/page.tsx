import type { Metadata } from "next";
import { and, asc, count, eq, max } from "drizzle-orm";
import { Card, CardHeader, PageHeader } from "@/components/ui";
import { db } from "@/db";
import { morningDashboardSends, roles, staff, staffAccessShops } from "@/db/schema";
import { hasContent, versionPlans } from "@/domain/morning-dashboard";
import { renderMorningHtml } from "@/domain/morning-render";
import { seesStaffContact, staffContact } from "@/domain/staff-contact";
import { formatDate, todayLocal } from "@/lib/time";
import { loadStaffAccess } from "@/server/auth/access";
import { guardPage } from "@/server/auth/staff";
import { buildMorningDashboard, loadMorningSettings, morningShops } from "@/server/morning-dashboard";
import { MorningEditor, type MorningPerson } from "./editor";

export const metadata: Metadata = { title: "Morning Dashboard email" };

export default async function MorningEmailPage() {
  const ctx = await guardPage("/admin/digest");
  const settings = await loadMorningSettings();
  const [roleRows, people, shopRoles, [last]] = await Promise.all([
    db.select({ key: roles.key, name: roles.name }).from(roles).orderBy(roles.sortOrder, roles.name),
    db
      .select({ id: staff.id, label: staff.displayLabel, email: staff.email, phone: staff.phone, role: roles.name, roleKey: roles.key })
      .from(staff)
      .innerJoin(roles, eq(roles.id, staff.roleId))
      .where(and(eq(staff.active, true), eq(staff.kind, "person")))
      .orderBy(asc(staff.displayLabel)),
    db.select({ staffId: staffAccessShops.staffId, key: roles.key }).from(staffAccessShops).innerJoin(roles, eq(roles.id, staffAccessShops.roleId)),
    db.select({ date: max(morningDashboardSends.date) }).from(morningDashboardSends).where(eq(morningDashboardSends.status, "queued")),
  ]);
  const accesses = await Promise.all(people.map((p) => loadStaffAccess(p.id)));
  const list: MorningPerson[] = people.map((p, i) => {
    const a = accesses[i];
    const eligible = a ? morningShops(a) : [];
    return {
      id: p.id,
      label: p.label,
      email: staffContact(seesStaffContact({ permissions: ctx.permissions, staffId: ctx.staff.id }, p.id), p).email,
      hasPhone: !!p.phone,
      role: p.role,
      roleKeys: [p.roleKey, ...shopRoles.filter((r) => r.staffId === p.id).map((r) => r.key)].filter((k): k is string => !!k),
      shops: a ? a.shops.filter((s) => eligible.includes(s.id)).map((s) => ({ id: s.id, name: s.name })) : [],
    };
  });
  const sent = last?.date
    ? (
        await db
          .select({ n: count() })
          .from(morningDashboardSends)
          .where(and(eq(morningDashboardSends.date, last.date), eq(morningDashboardSends.status, "queued"), eq(morningDashboardSends.channel, "email")))
      )[0].n
    : 0;

  const plans = versionPlans(morningShops(ctx.access), settings.versions[ctx.staff.id]);
  const preview = plans.length ? await buildMorningDashboard({ access: ctx.access, firstName: ctx.staff.firstName, shopIds: plans[0].shopIds, settings }) : null;
  const html = preview && hasContent(preview) ? renderMorningHtml(preview) : null;

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <PageHeader
        title="Morning Dashboard email"
        subtitle="Yesterday's numbers with week to date and the same day last week, today's schedule and what needs attention, emailed before the shops open. The owner and managers get every location in one email; shop managers get their shop. Each copy shows only what that person's reports allow."
      />
      <div className="grid gap-4 lg:grid-cols-[1fr_26rem]">
        <MorningEditor
          initial={settings}
          roles={roleRows.filter((r): r is { key: string; name: string } => !!r.key)}
          people={list}
          lastSent={last?.date ? `Last sent ${formatDate(last.date, "EEE MMM d")}${last.date === todayLocal() ? " (today)" : ""} to ${sent} ${sent === 1 ? "person" : "people"}.` : "Hasn't gone out yet."}
        />
        <Card className="self-start overflow-hidden">
          <CardHeader
            title="Your copy, right now"
            subtitle={
              html
                ? `${plans.length > 1 ? `The first of your ${plans.length} emails: ` : ""}${preview!.version.label}. Charts and links work in the email; the open dashboard has every barber.`
                : "You can't see the Morning Dashboard for any open shop, or every section you could see is off."
            }
          />
          {html && <iframe title="Morning Dashboard email preview" srcDoc={html} sandbox="" className="h-[48rem] w-full border-0 bg-zinc-100" />}
        </Card>
      </div>
    </div>
  );
}
