import type { Metadata } from "next";
import { asc, eq, and } from "drizzle-orm";
import { db } from "@/db";
import { shops, staff } from "@/db/schema";
import { PageHeader } from "@/components/ui";
import { requireStaff } from "@/server/auth/staff";
import { NewClientForm } from "./form";

export const metadata: Metadata = { title: "New client" };

export default async function NewClientPage() {
  const ctx = await requireStaff(["brand_admin", "shop_manager"]);
  const [shopRows, barbers] = await Promise.all([
    db.select({ id: shops.id, name: shops.name }).from(shops).orderBy(asc(shops.name)),
    db.select({ id: staff.id, label: staff.displayLabel }).from(staff).where(and(eq(staff.active, true), eq(staff.isBookable, true))).orderBy(asc(staff.displayLabel)),
  ]);
  return (
    <div className="mx-auto max-w-xl">
      <PageHeader title="New client" subtitle="If someone with this phone or email and a matching first name is already on file, you'll be taken to them instead." />
      <NewClientForm shops={shopRows} barbers={barbers} defaultShopId={ctx.currentShopId} />
    </div>
  );
}
