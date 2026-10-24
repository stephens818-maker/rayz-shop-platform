import type { Metadata } from "next";
import { asc } from "drizzle-orm";
import { db } from "@/db";
import { shops } from "@/db/schema";
import { Card, CardHeader, Empty, Notice, PageHeader } from "@/components/ui";
import { guardPage } from "@/server/auth/staff";
import { listLocationGroups } from "@/server/locations";
import { GroupEditor, GroupItem } from "./editor";

export const metadata: Metadata = { title: "Location groups" };

/** Saved sets of shops ("Quad Cities", "Iowa shops") that anyone can pick as a report filter. */
export default async function LocationGroupsPage() {
  const ctx = await guardPage("/admin/location-groups");
  const [groups, all] = await Promise.all([listLocationGroups(), db.select({ id: shops.id, name: shops.name, state: shops.state }).from(shops).orderBy(asc(shops.name))]);
  const editable = ctx.brandWide;

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <PageHeader
        title="Location groups"
        subtitle="Saved sets of shops for report filters. Everyone with reports can pick a group; each person sees only the shops in it they have access to."
      />
      {!editable && <Notice tone="blue">Groups cover shops across the brand, so only people with access to all shops can create or change them.</Notice>}
      <Card>
        <CardHeader title={`${groups.length} group${groups.length === 1 ? "" : "s"}`} />
        {groups.length === 0 ? (
          <div className="p-4">
            <Empty title="No groups yet" />
          </div>
        ) : (
          <ul className="divide-y divide-zinc-100">
            {groups.map((g) => (
              <GroupItem key={g.id} shops={all} group={g} editable={editable} />
            ))}
          </ul>
        )}
      </Card>
      {editable && (
        <Card>
          <CardHeader title="New group" subtitle="Pick two or more shops. Changes are recorded in the audit log." />
          <div className="p-4">
            <GroupEditor shops={all} group={null} />
          </div>
        </Card>
      )}
    </div>
  );
}
