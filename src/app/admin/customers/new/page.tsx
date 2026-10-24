import type { Metadata } from "next";
import { asc, eq, and, sql } from "drizzle-orm";
import { db } from "@/db";
import { staff } from "@/db/schema";
import { PageHeader } from "@/components/ui";
import { customFieldKey } from "@/domain/client-privacy";
import { guardPage, openShops } from "@/server/auth/staff";
import { clientPolicy } from "@/server/client-privacy";
import { inShops } from "@/server/tenant";
import { NewClientForm } from "./form";

export const metadata: Metadata = { title: "New client" };

export default async function NewClientPage() {
  const ctx = await guardPage("/admin/customers/new");
  const barbers = await db
    .select({ id: staff.id, label: staff.displayLabel })
    .from(staff)
    .where(and(eq(staff.active, true), eq(staff.isBookable, true), sql`exists (select 1 from staff_shops ss where ss.staff_id = ${staff.id} and ${inShops(ctx, sql`ss.shop_id`)})`))
    .orderBy(asc(staff.displayLabel));
  const policy = await clientPolicy(ctx);
  const fields = (["phone", "email", "address", "birthday", "preferred_barber", "notes", ...policy.custom.map((f) => customFieldKey(f.id))] as const)
    .filter((f) => policy.canAdd(f))
    .map((f) => ({ key: f, label: policy.custom.find((c) => customFieldKey(c.id) === f)?.label, level: policy.level(f) }));
  return (
    <div className="mx-auto max-w-xl">
      <PageHeader title="New client" subtitle="If someone with this phone or email and a matching first name is already on file, you'll be taken to them instead." />
      <NewClientForm shops={openShops(ctx).map((s) => ({ id: s.id, name: s.name }))} barbers={barbers} defaultShopId={ctx.currentShopId} fields={fields} />
    </div>
  );
}
