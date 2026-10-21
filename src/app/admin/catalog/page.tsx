import type { Metadata } from "next";
import Link from "next/link";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { importRuns, staff } from "@/db/schema";
import { Card, CardHeader, PageHeader, Table, Td, Th, buttonClass } from "@/components/ui";
import { formatDateTime } from "@/lib/time";
import { can, guardPage } from "@/server/auth/staff";
import { CatalogUploader } from "./uploader";

export const metadata: Metadata = { title: "Bulk upload" };

export default async function CatalogPage() {
  const ctx = await guardPage("/admin/catalog");
  const mode = can(ctx, "catalog.manage") ? "catalog" : "stock";
  const runs = await db
    .select({ r: importRuns, by: staff.displayLabel })
    .from(importRuns)
    .leftJoin(staff, eq(staff.id, importRuns.staffId))
    .where(and(inArray(importRuns.kind, ["catalog", "catalog_stock"]), ctx.brandWide ? undefined : eq(importRuns.staffId, ctx.staff.id)))
    .orderBy(desc(importRuns.createdAt))
    .limit(10);

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Bulk upload"
        subtitle={
          mode === "catalog"
            ? "Add or update retail products and services from a spreadsheet, and push them to shops. Rows match existing items by SKU."
            : "Update stock and low-stock levels at your shops from a spreadsheet. Rows match products by SKU."
        }
        actions={
          <div className="flex flex-wrap gap-2">
            <a className={buttonClass("secondary", "sm")} href="/admin/catalog/template?format=xlsx">
              Template (XLSX)
            </a>
            <a className={buttonClass("secondary", "sm")} href="/admin/catalog/template?format=csv">
              Template (CSV)
            </a>
            <a className={buttonClass("dark", "sm")} href="/admin/catalog/export">
              Export catalog CSV
            </a>
          </div>
        }
      />
      <CatalogUploader mode={mode} shops={ctx.shops.map((s) => ({ id: s.id, name: s.name }))} canPushAll={mode === "stock" || ctx.brandWide} />

      <Card className="mt-6">
        <CardHeader title="Recent uploads" subtitle={ctx.brandWide ? "Everyone's uploads" : "Your uploads"} />
        {runs.length === 0 ? (
          <p className="p-4 text-sm text-zinc-500">No uploads yet.</p>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>When</Th>
                <Th>File</Th>
                <Th>By</Th>
                <Th>Kind</Th>
                <Th right>Rows</Th>
                <Th right>New</Th>
                <Th right>Updated</Th>
                <Th right>Skipped</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {runs.map(({ r, by }) => (
                <tr key={r.id}>
                  <Td className="whitespace-nowrap">{formatDateTime(r.createdAt)}</Td>
                  <Td className="max-w-56 truncate">{r.filename}</Td>
                  <Td>{by ?? "—"}</Td>
                  <Td>{r.kind === "catalog" ? "Catalog" : "Stock only"}</Td>
                  <Td right>{r.totalRows}</Td>
                  <Td right>{r.inserted}</Td>
                  <Td right>{r.updated}</Td>
                  <Td right>{r.skipped}</Td>
                  <Td right>
                    {r.skipped > 0 && (
                      <Link className="text-xs underline" href={`/admin/import/${r.id}/errors`}>
                        Skipped rows CSV
                      </Link>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}
