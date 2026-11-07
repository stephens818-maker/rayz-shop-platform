import type { Metadata } from "next";
import Link from "next/link";
import { Card, CardHeader, Empty, PageHeader, cx } from "@/components/ui";
import { DuplicateKind, SIGNAL_LABEL, pickKeeper } from "@/domain/duplicates";
import { formatDate } from "@/lib/time";
import { can, guardPage } from "@/server/auth/staff";
import { clientPolicy, recordClientAccess } from "@/server/client-privacy";
import { DuplicateClient, duplicatePairs } from "@/server/customers";
import { NoCopy } from "../privacy";
import { DupPerson, DuplicateGroup } from "./merge-buttons";

export const metadata: Metadata = { title: "Duplicate clients" };

const GROUPS: { kind: DuplicateKind; title: string; subtitle: string }[] = [
  { kind: "likely", title: "Likely the same person", subtitle: "Same phone or email and matching names (Mike / Michael, a nickname, a typo, a missing last name)." },
  { kind: "same_name", title: "Same name, backed by another detail", subtitle: "Same or matching name plus a birthday, zip or phone last 4, or one record with no contact (common after a Squire import or a walk-in)." },
  { kind: "similar_name", title: "Close spelling, backed by another detail", subtitle: "A typo-close name (Jonathon / Jonathan) plus a birthday, zip, phone last 4, or a record with no contact. Check before merging." },
  {
    kind: "shared_contact",
    title: "Shared phone or email, something differs",
    subtitle: "Different first names or birthdays: often a parent and child. Put a child on their parent's family account, or leave these alone unless you know it's one person.",
  },
];

const CONFLICT_LABEL: Record<string, string> = { birthday: "birthday", first_name: "first name" };

export default async function DuplicatesPage({ searchParams }: { searchParams: Promise<{ from?: string }> }) {
  const ctx = await guardPage("/admin/customers/duplicates");
  const sp = await searchParams;
  const squireOnly = sp.from === "squire";
  await recordClientAccess(ctx, { kind: "list", detail: { via: "duplicates", squireOnly } });
  const policy = await clientPolicy(ctx);
  const pairs = await duplicatePairs({ limit: 300, squireOnly });
  const person = (c: DuplicateClient): DupPerson => ({
    id: c.id,
    label: policy.name(c.firstName, c.lastName) + (c.nickname ? ` (${c.nickname})` : ""),
    detail: [policy.show("phone", c.phone), policy.show("email", c.email), `since ${formatDate(c.createdAt, "MMM yyyy")}`].filter(Boolean).join(" · "),
    squire: c.squire,
    visits: c.visits,
  });
  const tab = (on: boolean) => cx("rounded-full px-3 py-1 text-sm ring-1 ring-inset", on ? "bg-zinc-900 text-white ring-zinc-900" : "bg-white text-zinc-700 ring-zinc-300 hover:bg-zinc-50");
  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <PageHeader
        title="Duplicate clients"
        subtitle="Nothing merges automatically. Merging moves visits, tickets, loyalty, gift cards, coupons, messages, tags, consent records and Squire IDs onto the record you keep."
      />
      <div className="flex gap-2">
        <Link href="/admin/customers/duplicates" className={tab(!squireOnly)}>
          All clients
        </Link>
        <Link href="/admin/customers/duplicates?from=squire" className={tab(squireOnly)}>
          Imported from Squire
        </Link>
      </div>
      {pairs.length === 0 && <Empty title="No duplicates found" />}
      <NoCopy what="the client list">
        <div className="space-y-4">
          {GROUPS.map((g) => {
            const list = pairs.filter((p) => p.kind === g.kind);
            if (!list.length) return null;
            return (
              <Card key={g.kind}>
                <CardHeader title={`${g.title} (${list.length})`} subtitle={g.subtitle} />
                <DuplicateGroup
                  family={g.kind === "shared_contact" && can(ctx, "clients.family")}
                  rows={list.map((p) => ({
                    a: person(p.a),
                    b: person(p.b),
                    score: p.score,
                    signals: p.signals.map((s) => SIGNAL_LABEL[s]),
                    conflicts: p.conflicts.map((c) => CONFLICT_LABEL[c] ?? c),
                    keeps: pickKeeper(p.a, p.b)[0].id === p.a.id ? "a" : "b",
                  }))}
                />
              </Card>
            );
          })}
        </div>
      </NoCopy>
    </div>
  );
}
