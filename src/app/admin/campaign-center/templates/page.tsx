import type { Metadata } from "next";
import Link from "next/link";
import { Badge, Card, CardHeader, Empty, LinkButton, PageHeader, Table, Td, Th } from "@/components/ui";
import { CHANNEL_LABEL } from "@/domain/marketing";
import { formatDateTime } from "@/lib/time";
import { can, guardPage } from "@/server/auth/staff";
import { loadMarketingSettings } from "@/server/marketing/settings";
import { listTemplates } from "@/server/marketing/templates";
import { NewTemplate, TemplateRowActions } from "./editor";

export const metadata: Metadata = { title: "Templates" };
export const dynamic = "force-dynamic";

const STATUS = { draft: { label: "Draft", tone: "gray" }, approved: { label: "Approved", tone: "green" }, archived: { label: "Archived", tone: "red" } } as const;

export default async function TemplatesPage({ searchParams }: { searchParams: Promise<{ archived?: string }> }) {
  const ctx = await guardPage("/admin/campaign-center/templates");
  const sp = await searchParams;
  const brand = can(ctx, "campaign_center.create") && ctx.brandWide;
  const [list, settings] = await Promise.all([listTemplates(ctx, { archived: sp.archived === "1" }), loadMarketingSettings()]);
  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <PageHeader
        title="Template library"
        subtitle={
          <>
            <Link href="/admin/campaign-center" className="underline">
              Campaign Center
            </Link>{" "}
            · {brand ? "Wording the brand approves for every location. Locations start a blast from an approved template and change what they need." : "The brand's approved wording. Start a blast from one in the blast's Content step."}
          </>
        }
        actions={
          <>
            {brand && (
              <Link className="text-sm underline" href={sp.archived === "1" ? "?" : "?archived=1"}>
                {sp.archived === "1" ? "Hide archived" : "Show archived"}
              </Link>
            )}
            {can(ctx, "campaign_center.create") && <LinkButton href="/admin/campaign-center/blasts/new">New blast</LinkButton>}
          </>
        }
      />
      <Card>
        <CardHeader title={brand ? "Templates" : "Approved templates"} />
        {list.length ? (
          <Table>
            <thead>
              <tr>
                <Th>Name</Th>
                <Th>Type</Th>
                <Th>Channels</Th>
                <Th>Status</Th>
                {brand && <Th />}
              </tr>
            </thead>
            <tbody>
              {list.map((t) => (
                <tr key={t.id}>
                  <Td className="whitespace-normal">
                    <div className="font-semibold">{t.name}</div>
                    {t.description && <div className="text-xs text-zinc-500">{t.description}</div>}
                    <div className="mt-1 max-w-xl truncate text-xs text-zinc-500">{t.templates.sms}</div>
                  </Td>
                  <Td>{t.campaignType === "promotion" ? "Promotion" : "Quick update"}</Td>
                  <Td className="text-xs">{t.channels.map((c) => CHANNEL_LABEL[c]).join(", ")}</Td>
                  <Td>
                    <Badge tone={STATUS[t.status].tone}>{STATUS[t.status].label}</Badge>
                    {t.status === "approved" && t.approvedAt && (
                      <div className="mt-0.5 text-[11px] text-zinc-500">
                        {t.approvedBy ? `${t.approvedBy}, ` : ""}
                        {formatDateTime(t.approvedAt)}
                      </div>
                    )}
                  </Td>
                  {brand && (
                    <Td right className="whitespace-normal">
                      <TemplateRowActions row={{ id: t.id, name: t.name, campaignType: t.campaignType, description: t.description, channels: t.channels, templates: t.templates, status: t.status }} address={settings.address} />
                    </Td>
                  )}
                </tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <div className="p-4">
            <Empty title="No templates yet">{brand ? "Write one below and approve it for every location." : "The brand hasn't approved any yet."}</Empty>
          </div>
        )}
        {brand && <NewTemplate address={settings.address} />}
      </Card>
    </div>
  );
}
