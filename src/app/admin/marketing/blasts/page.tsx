import type { Metadata } from "next";
import Link from "next/link";
import { Badge, Card, Empty, LinkButton, PageHeader, Table, Td, Th } from "@/components/ui";
import { CHANNEL_LABEL } from "@/domain/marketing";
import { formatDateTime } from "@/lib/time";
import { can, guardPage, openShops } from "@/server/auth/staff";
import { listBlasts } from "@/server/marketing/campaigns";
import { OTHER_SHOP } from "@/server/tenant";

export const metadata: Metadata = { title: "Blasts" };
export const dynamic = "force-dynamic";

const STATUS: Record<string, { label: string; tone: "gray" | "green" | "blue" | "amber" | "red" }> = {
  draft: { label: "Draft", tone: "gray" },
  scheduled: { label: "Scheduled", tone: "blue" },
  sending: { label: "Sending", tone: "amber" },
  sent: { label: "Sent", tone: "green" },
  cancelled: { label: "Cancelled", tone: "red" },
};

export default async function BlastsPage() {
  const ctx = await guardPage("/admin/marketing/blasts");
  const list = await listBlasts(ctx);
  const shops = openShops(ctx);
  const maySend = can(ctx, "marketing.location") || can(ctx, "marketing.manage");
  const where = (ids: string[]) => (ids.length ? ids.map((id) => shops.find((s) => s.id === id)?.name ?? OTHER_SHOP).join(", ") : "Every location");
  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <PageHeader
        title="Blasts"
        subtitle={
          <>
            <Link href="/admin/marketing" className="underline">
              Marketing
            </Link>{" "}
            · One-off messages to a segment of clients who agreed to marketing. Each client gets it once, on the first channel they agreed to.
          </>
        }
        actions={maySend && <LinkButton href="/admin/marketing/blasts/new">New blast</LinkButton>}
      />
      <Card>
        {list.length ? (
          <Table>
            <thead>
              <tr>
                <Th>Name</Th>
                <Th>Status</Th>
                <Th>Channels</Th>
                <Th>Locations</Th>
                <Th>When</Th>
                <Th right>Sent</Th>
              </tr>
            </thead>
            <tbody>
              {list.map((b) => (
                <tr key={b.id}>
                  <Td>
                    <Link href={`/admin/marketing/blasts/${b.id}`} className="font-semibold hover:underline">
                      {b.name}
                    </Link>
                  </Td>
                  <Td>
                    <Badge tone={STATUS[b.status]?.tone ?? "gray"}>{STATUS[b.status]?.label ?? b.status}</Badge>
                  </Td>
                  <Td className="text-xs">{b.channels.map((c) => CHANNEL_LABEL[c]).join(" → ")}</Td>
                  <Td className="text-xs">{where(b.shopIds)}</Td>
                  <Td className="text-xs">{b.sentAt ? formatDateTime(b.sentAt) : b.scheduledAt ? formatDateTime(b.scheduledAt) : "—"}</Td>
                  <Td right>{b.sent}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <Empty title="No blasts yet">{maySend ? "Write one, pick who gets it, preview the count and send a test to yourself first." : "Blasts your locations send show up here."}</Empty>
        )}
      </Card>
    </div>
  );
}
