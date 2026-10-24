import type { Metadata } from "next";
import Link from "next/link";
import { db } from "@/db";
import { products, services } from "@/db/schema";
import { PageHeader } from "@/components/ui";
import { LOOKUP_DEFS, LOOKUP_KEYS, resolveLookups } from "@/domain/lookups";
import { guardPage } from "@/server/auth/staff";
import { savedLookups } from "@/server/lookups";
import { LookupEditor } from "./editor";

export const metadata: Metadata = { title: "Picklists" };

export default async function ListsPage() {
  await guardPage("/admin/lists");
  const [saved, svc, prod] = await Promise.all([savedLookups(), db.selectDistinct({ c: services.category }).from(services), db.selectDistinct({ c: products.category }).from(products)]);
  const lists = resolveLookups(saved);
  const inUse: Partial<Record<keyof typeof LOOKUP_DEFS, string[]>> = { serviceCategories: svc.map((r) => r.c), productCategories: prod.map((r) => r.c) };
  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <PageHeader
        title="Picklists"
        subtitle={
          <>
            The choices staff pick from across every shop. They can still type something else when it doesn&apos;t fit. Reasons for blocks and time off are under{" "}
            <Link className="underline" href="/admin/block-reasons">
              Block reasons
            </Link>
            ; client message wording under{" "}
            <Link className="underline" href="/admin/messages">
              Client messages
            </Link>
            .
          </>
        }
      />
      {LOOKUP_KEYS.map((k) => (
        <LookupEditor key={k} id={k} label={LOOKUP_DEFS[k].label} hint={LOOKUP_DEFS[k].hint} items={lists[k]} inUse={inUse[k] ?? []} />
      ))}
    </div>
  );
}
