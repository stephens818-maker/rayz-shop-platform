import type { Metadata } from "next";
import { and, asc, count, eq, gte } from "drizzle-orm";
import { Card, CardHeader, Notice, PageHeader } from "@/components/ui";
import { db } from "@/db";
import { auditLog, roles } from "@/db/schema";
import { loadAssistantSettings } from "@/server/assistant";
import { providerStatus } from "@/server/assistant/providers";
import { guardPage } from "@/server/auth/staff";
import { AssistantSettingsEditor } from "./editor";

export const metadata: Metadata = { title: "Rayz Assistant" };
export const dynamic = "force-dynamic";

const PROVIDER_LABEL = { openai: "OpenAI", anthropic: "Anthropic", stub: "Built-in demo (no API key)" } as const;

export default async function AssistantSettingsPage() {
  await guardPage("/admin/assistant/settings");
  const week = new Date(Date.now() - 7 * 24 * 60 * 60_000);
  const [settings, roleRows, [asked], [tools]] = await Promise.all([
    loadAssistantSettings(),
    db.select({ id: roles.id, name: roles.name, key: roles.key }).from(roles).orderBy(asc(roles.sortOrder), asc(roles.name)),
    db.select({ n: count() }).from(auditLog).where(and(eq(auditLog.action, "assistant.question"), gte(auditLog.at, week))),
    db.select({ n: count() }).from(auditLog).where(and(eq(auditLog.action, "assistant.tool"), gte(auditLog.at, week))),
  ]);
  const p = providerStatus();
  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <PageHeader
        title="Rayz Assistant"
        subtitle="A chat panel on every admin page that answers questions about the business from the same reports people can open, and explains how to use the software. It runs with the asking person's permissions and locations, never sees client contact details or anything Client data hides from them, and can only draft blasts and purchase orders for them to confirm."
      />
      <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
        <AssistantSettingsEditor initial={settings} roles={roleRows} />
        <div className="space-y-4 self-start">
          <Card>
            <CardHeader title="Provider" subtitle="Set on the server with environment variables. Keys are never shown here." />
            <div className="space-y-2 px-4 py-3 text-sm text-zinc-700">
              {p.id ? (
                <>
                  <div>
                    <span className="font-medium text-zinc-900">{PROVIDER_LABEL[p.id]}</span>
                    {p.id !== "stub" && <span className="text-zinc-500"> · {p.model}</span>}
                  </div>
                  <p className="text-xs text-zinc-500">{p.retention}</p>
                  {p.id === "stub" && <p className="text-xs text-zinc-500">The demo routes questions to reports by keywords. Set OPENAI_API_KEY or ANTHROPIC_API_KEY for real answers.</p>}
                </>
              ) : (
                <Notice tone="amber">{p.problem} Until then nobody sees the assistant.</Notice>
              )}
            </div>
          </Card>
          <Card>
            <CardHeader title="Last 7 days" subtitle="Every question and tool call is in the audit log." />
            <div className="grid grid-cols-2 gap-2 px-4 py-3 text-sm">
              <div>
                <div className="text-xs text-zinc-500">Questions</div>
                <div className="text-lg font-semibold">{asked.n}</div>
              </div>
              <div>
                <div className="text-xs text-zinc-500">Tool calls</div>
                <div className="text-lg font-semibold">{tools.n}</div>
              </div>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
