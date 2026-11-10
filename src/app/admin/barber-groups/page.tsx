import type { Metadata } from "next";
import { asc } from "drizzle-orm";
import { db } from "@/db";
import { shops } from "@/db/schema";
import { Card, CardHeader, Empty, Notice, PageHeader } from "@/components/ui";
import { guardPage } from "@/server/auth/staff";
import { barbersAt, listBarberGroups } from "@/server/barbers";
import { BarberGroupEditor, BarberGroupItem } from "./editor";

export const metadata: Metadata = { title: "Barber groups" };

/** Saved sets of barbers ("Floaters", "Senior barbers") that people with reports can pick as a filter. */
export default async function BarberGroupsPage() {
  const ctx = await guardPage("/admin/barber-groups");
  const allShops = await db.select({ id: shops.id, name: shops.name }).from(shops).orderBy(asc(shops.name));
  const [groups, refs] = await Promise.all([listBarberGroups(), barbersAt(allShops.map((s) => s.id))]);
  const shopName = new Map(allShops.map((s) => [s.id, s.name]));
  const barbers = refs.map((b) => ({ id: b.id, name: b.name, active: b.active !== false, shops: b.shopIds.map((id) => shopName.get(id) ?? "").sort() }));
  const editable = ctx.brandWide;
  const shopNames = allShops.map((s) => s.name);

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <PageHeader
        title="Barber groups"
        subtitle="Saved sets of barbers for report filters. Everyone who can see every barber's numbers can pick a group; each person sees only the barbers in it who work at their shops."
      />
      {!editable && <Notice tone="blue">Groups can include barbers at any shop, so only people with access to all shops can create or change them.</Notice>}
      <Card>
        <CardHeader title={`${groups.length} group${groups.length === 1 ? "" : "s"}`} />
        {groups.length === 0 ? (
          <div className="p-4">
            <Empty title="No groups yet" />
          </div>
        ) : (
          <ul className="divide-y divide-zinc-100">
            {groups.map((g) => (
              <BarberGroupItem key={g.id} barbers={barbers} shops={shopNames} group={g} editable={editable} />
            ))}
          </ul>
        )}
      </Card>
      {editable && (
        <Card>
          <CardHeader title="New group" subtitle="Pick two or more barbers, from any shops. Changes are recorded in the audit log." />
          <div className="p-4">
            <BarberGroupEditor barbers={barbers} shops={shopNames} group={null} />
          </div>
        </Card>
      )}
    </div>
  );
}
