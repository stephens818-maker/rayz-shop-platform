import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/db";
import { PageHeader } from "@/components/ui";
import { seesStaffContact, staffContact } from "@/domain/staff-contact";
import { loadStaffAccess } from "@/server/auth/access";
import { guardPage } from "@/server/auth/staff";
import { inTenant } from "@/server/tenant";
import { PersonAccessSection } from "./access-section";

export const metadata: Metadata = { title: "Access" };

export default async function PersonAccessPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await guardPage("/admin/permissions/people/[id]");
  if (!(await inTenant(ctx, "staff", id))) notFound();
  const target = await loadStaffAccess(id);
  if (!target) notFound();
  const person = (await db.query.staff.findFirst({ where: (s, { eq }) => eq(s.id, id) }))!;

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
            {person.kind === "person" && (
              <>
                ·{" "}
                <Link className="underline" href={`/admin/users/${id}`}>
                  Sign-in and account
                </Link>{" "}
              </>
            )}
            · {staffContact(seesStaffContact({ permissions: ctx.permissions, staffId: ctx.staff.id }, id), person).email ?? "no login"}
          </>
        }
      />
      <PersonAccessSection ctx={ctx} target={target} />
    </div>
  );
}
