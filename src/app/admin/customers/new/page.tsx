import type { Metadata } from "next";
import { asc, eq, and, sql } from "drizzle-orm";
import { db } from "@/db";
import { staff } from "@/db/schema";
import { PageHeader } from "@/components/ui";
import { guardPage } from "@/server/auth/staff";
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
  return (
    <div className="mx-auto max-w-xl">
      <PageHeader title="New client" subtitle="If someone with this phone or email and a matching first name is already on file, you'll be taken to them instead." />
      <NewClientForm shops={ctx.shops.map((s) => ({ id: s.id, name: s.name }))} barbers={barbers} defaultShopId={ctx.currentShopId} />
    </div>
  );
}
