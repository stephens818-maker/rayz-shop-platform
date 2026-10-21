import type { Metadata } from "next";
import Link from "next/link";
import { Card, CardHeader, Empty, PageHeader, Table, Td, Th } from "@/components/ui";
import { formatPhone } from "@/lib/phone";
import { formatDate } from "@/lib/time";
import { requireStaff } from "@/server/auth/staff";
import { DuplicateKind, duplicatePairs } from "@/server/customers";
import { MergeButtons } from "./merge-buttons";

export const metadata: Metadata = { title: "Duplicate clients" };

const GROUPS: { kind: DuplicateKind; title: string; subtitle: string }[] = [
  { kind: "likely", title: "Likely the same person", subtitle: "Same phone or email and compatible names (Mike / Michael, missing last name)." },
  { kind: "same_name", title: "Same name, one record has no contact", subtitle: "Usually a walk-in entered without a phone. Check before merging." },
  { kind: "shared_contact", title: "Shared phone or email, different names", subtitle: "Often a family. Leave these alone unless you know it's one person." },
];

export default async function DuplicatesPage() {
  await requireStaff(["brand_admin", "shop_manager"]);
  const pairs = await duplicatePairs({ limit: 200 });
  const person = (c: (typeof pairs)[number]["a"]) => (
    <div>
      <Link className="font-medium underline" href={`/admin/customers/${c.id}`}>
        {c.firstName} {c.lastName}
      </Link>
      <div className="text-xs text-zinc-500">
        {[formatPhone(c.phone), c.email, `since ${formatDate(c.createdAt, "MMM yyyy")}`].filter(Boolean).join(" · ")}
      </div>
    </div>
  );
  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <PageHeader title="Duplicate clients" subtitle="Nothing merges automatically. Merging moves visits, tickets, loyalty, gift cards, and Squire IDs onto the record you keep." />
      {pairs.length === 0 && <Empty title="No duplicates found" />}
      {GROUPS.map((g) => {
        const list = pairs.filter((p) => p.kind === g.kind);
        if (!list.length) return null;
        return (
          <Card key={g.kind}>
            <CardHeader title={`${g.title} (${list.length})`} subtitle={g.subtitle} />
            <Table>
              <thead>
                <tr>
                  <Th>Client A</Th>
                  <Th>Client B</Th>
                  <Th>Shared</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {list.map((p) => (
                  <tr key={`${p.a.id}-${p.b.id}`}>
                    <Td>{person(p.a)}</Td>
                    <Td>{person(p.b)}</Td>
                    <Td className="text-xs text-zinc-600">{[p.samePhone && "phone", p.sameEmail && "email", !p.samePhone && !p.sameEmail && "name"].filter(Boolean).join(", ")}</Td>
                    <Td right>
                      <MergeButtons a={{ id: p.a.id, label: `${p.a.firstName} ${p.a.lastName ?? ""}`.trim() }} b={{ id: p.b.id, label: `${p.b.firstName} ${p.b.lastName ?? ""}`.trim() }} />
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Card>
        );
      })}
    </div>
  );
}
