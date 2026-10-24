import type { Metadata } from "next";
import Link from "next/link";
import { Badge, Card, CardHeader, Empty, LinkButton, PageHeader, Table, Td, Th } from "@/components/ui";
import { VISIBILITY_LABEL, sourceLabel } from "@/domain/report-builder";
import { formatDateTime } from "@/lib/time";
import { can, guardPage } from "@/server/auth/staff";
import { listSavedReports, type SavedReportItem } from "@/server/report-builder/saved";
import { RowActions } from "./row-actions";

export const metadata: Metadata = { title: "Custom reports" };
export const dynamic = "force-dynamic";

function List({ title, subtitle, items, build }: { title: string; subtitle: string; items: SavedReportItem[]; build: boolean }) {
  if (!items.length) return null;
  return (
    <Card>
      <CardHeader title={title} subtitle={subtitle} />
      <Table>
        <thead>
          <tr>
            <Th>Report</Th>
            <Th>Shared</Th>
            <Th>Email</Th>
            <Th>Owner</Th>
            <Th>Updated</Th>
            <Th />
          </tr>
        </thead>
        <tbody>
          {items.map((r) => (
            <tr key={r.id} className="align-top">
              <Td>
                <Link href={`/admin/reports/custom/${r.id}`} className="font-medium hover:underline">
                  {r.name}
                </Link>
                <div className="text-xs text-zinc-500">
                  {sourceLabel(r.source)}
                  {r.description ? ` · ${r.description}` : ""}
                </div>
              </Td>
              <Td className="text-xs">
                <Badge tone={r.visibility === "template" ? "violet" : r.visibility === "roles" ? "blue" : "gray"}>{r.visibility === "roles" ? "Roles" : r.visibility === "template" ? "Template" : "Only me"}</Badge>
                {r.roles.length > 0 && <div className="mt-1 text-zinc-500">{r.roles.join(", ")}</div>}
              </Td>
              <Td className="text-xs text-zinc-600">
                {r.schedule ?? "—"}
                {r.morning && <div className="text-zinc-500">In the Morning Dashboard</div>}
              </Td>
              <Td className="whitespace-nowrap text-xs">{r.mine ? "You" : r.owner}</Td>
              <Td className="whitespace-nowrap text-xs text-zinc-500">{formatDateTime(r.updatedAt)}</Td>
              <Td className="whitespace-nowrap text-right">
                <RowActions id={r.id} name={r.name} build={build} mayEdit={r.mayEdit} />
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </Card>
  );
}

/** Saved custom reports this person may open: their own, ones shared with their roles, and the brand's templates. */
export default async function CustomReportsPage() {
  const ctx = await guardPage("/admin/reports/custom");
  const build = can(ctx, "report_builder.build");
  const all = await listSavedReports(ctx);
  const mine = all.filter((r) => r.mine && r.visibility !== "template");
  const shared = all.filter((r) => !r.mine && r.visibility === "roles");
  const templates = all.filter((r) => r.visibility === "template");
  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <PageHeader
        title="Custom reports"
        subtitle={
          <>
            <Link href="/admin/reports" className="underline">
              Reports
            </Link>{" "}
            · Pick the columns, filters, grouping and totals you need. Everyone sees a report through their own access: their locations, and client details as Client data allows them.
          </>
        }
        actions={build ? <LinkButton href="/admin/reports/custom/new">New report</LinkButton> : undefined}
      />
      {!all.length && (
        <Empty title="No saved reports yet">{build ? "Build one from the client list's fields and filters, then save it, share it or have it emailed." : "Reports shared with your role and the brand's templates show up here."}</Empty>
      )}
      <List title="Your reports" subtitle={VISIBILITY_LABEL.private + " unless shared"} items={mine} build={build} />
      <List title="Shared with you" subtitle="Shared with one of your roles. Duplicate one to change it." items={shared} build={build} />
      <List title="Brand templates" subtitle="Starting points for everyone with custom reports." items={templates} build={build} />
    </div>
  );
}
