import type { Metadata } from "next";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { importRuns, staff } from "@/db/schema";
import { Badge, Card, CardHeader, Empty, PageHeader, Table, Td, Th } from "@/components/ui";
import { formatDateTime } from "@/lib/time";
import { requireStaff } from "@/server/auth/staff";
import { Importer } from "./importer";

export const metadata: Metadata = { title: "Import from Squire" };

const KIND_LABEL: Record<string, string> = { clients: "Clients", appointments: "Appointments", loyalty: "Loyalty balances", gift_cards: "Gift cards" };

export default async function ImportPage() {
  await requireStaff(["brand_admin"]);
  const runs = await db
    .select({ r: importRuns, by: staff.displayLabel })
    .from(importRuns)
    .leftJoin(staff, eq(staff.id, importRuns.staffId))
    .orderBy(desc(importRuns.createdAt))
    .limit(30);

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Import from Squire"
        subtitle="Upload Squire CSV exports. Every file is checked with a dry run first; nothing is saved until you commit. Re-running the same file is safe (rows match on Squire ID, then phone, then email)."
      />
      <Importer />
      <Card className="mt-4">
        <CardHeader title="Import history" subtitle="Committed imports only. Dry runs aren't recorded." />
        {runs.length === 0 ? (
          <Empty title="No imports yet" />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>When</Th>
                <Th>Type</Th>
                <Th>File</Th>
                <Th right>Rows</Th>
                <Th right>Added</Th>
                <Th right>Updated</Th>
                <Th right>Skipped</Th>
                <Th>By</Th>
              </tr>
            </thead>
            <tbody>
              {runs.map(({ r, by }) => (
                <tr key={r.id}>
                  <Td>{formatDateTime(r.createdAt)}</Td>
                  <Td>{KIND_LABEL[r.kind] ?? r.kind}</Td>
                  <Td className="max-w-48 truncate">{r.filename ?? "—"}</Td>
                  <Td right>{r.totalRows}</Td>
                  <Td right>{r.inserted}</Td>
                  <Td right>{r.updated}</Td>
                  <Td right>{r.skipped ? <Badge tone={r.errors.length ? "amber" : "gray"}>{r.skipped}</Badge> : 0}</Td>
                  <Td>{by ?? "—"}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}
