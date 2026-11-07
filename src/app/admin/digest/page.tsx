import type { Metadata } from "next";
import { Suspense } from "react";
import { and, asc, count, eq, max } from "drizzle-orm";
import { Card, CardHeader, PageHeader } from "@/components/ui";
import { db } from "@/db";
import { morningDashboardSends, roles, staff, staffAccessShops } from "@/db/schema";
import { hasContent, versionPlans } from "@/domain/morning-dashboard";
import { renderMorningHtml } from "@/domain/morning-render";
import { seesStaffContact, staffContact } from "@/domain/staff-contact";
import { formatDate, todayLocal } from "@/lib/time";
import { guardPage } from "@/server/auth/staff";
import { buildMorningDashboard, loadMorningSettings, morningRecipientShops, morningShops } from "@/server/morning-dashboard";
import { MorningEditor, type MorningPerson } from "./editor";

export const metadata: Metadata = { title: "Morning Dashboard email" };

export default async function MorningEmailPage() {
  const ctx = await guardPage("/admin/digest");
  const settings = await loadMorningSettings();
  const previewPlans = versionPlans(morningShops(ctx.access), settings.versions[ctx.staff.id]);
  const previewPromise = previewPlans.length ? buildMorningDashboard({ access: ctx.access, firstName: ctx.staff.firstName, shopIds: previewPlans[0].shopIds, settings }) : Promise.resolve(null);
  const [roleRows, people, shopRoles, [last], shopLists] = await Promise.all([
    db.select({ key: roles.key, name: roles.name }).from(roles).orderBy(roles.sortOrder, roles.name),
    db
      .select({ id: staff.id, label: staff.displayLabel, email: staff.email, phone: staff.phone, role: roles.name, roleKey: roles.key })
      .from(staff)
      .innerJoin(roles, eq(roles.id, staff.roleId))
      .where(and(eq(staff.active, true), eq(staff.kind, "person")))
      .orderBy(asc(staff.displayLabel)),
    db.select({ staffId: staffAccessShops.staffId, key: roles.key }).from(staffAccessShops).innerJoin(roles, eq(roles.id, staffAccessShops.roleId)),
    db.select({ date: max(morningDashboardSends.date) }).from(morningDashboardSends).where(eq(morningDashboardSends.status, "queued")),
    morningRecipientShops(),
  ]);
  const list: MorningPerson[] = people.map((p) => ({
    id: p.id,
    label: p.label,
    email: staffContact(seesStaffContact({ permissions: ctx.permissions, staffId: ctx.staff.id }, p.id), p).email,
    hasPhone: !!p.phone,
    role: p.role,
    roleKeys: [p.roleKey, ...shopRoles.filter((r) => r.staffId === p.id).map((r) => r.key)].filter((k): k is string => !!k),
    shops: shopLists.get(p.id) ?? [],
  }));
  const sent = last?.date
    ? (
        await db
          .select({ n: count() })
          .from(morningDashboardSends)
          .where(and(eq(morningDashboardSends.date, last.date), eq(morningDashboardSends.status, "queued"), eq(morningDashboardSends.channel, "email")))
      )[0].n
    : 0;

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
        <Suspense fallback={<Card className="self-start"><CardHeader title="Your copy, right now" subtitle="Loading the preview…" /></Card>}>
          <DigestPreview plans={previewPlans.length} promise={previewPromise} />
        </Suspense>
      </div>
    </div>
  );
}

async function DigestPreview({ plans, promise }: { plans: number; promise: ReturnType<typeof buildMorningDashboard> }) {
  const preview = await promise;
  const html = preview && hasContent(preview) ? renderMorningHtml(preview) : null;
  return (
    <Card className="self-start overflow-hidden">
      <CardHeader
        title="Your copy, right now"
        subtitle={
          html
            ? `${plans > 1 ? `The first of your ${plans} emails: ` : ""}${preview!.version.label}. Charts and links work in the email; the open dashboard has every barber.`
            : "You can't see the Morning Dashboard for any open shop, or every section you could see is off."
        }
      />
      {html && <iframe title="Morning Dashboard email preview" srcDoc={html} sandbox="" className="h-[48rem] w-full border-0 bg-zinc-100" />}
    </Card>
  );
}
