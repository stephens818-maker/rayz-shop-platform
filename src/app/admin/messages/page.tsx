import type { Metadata } from "next";
import { PageHeader } from "@/components/ui";
import { guardPage } from "@/server/auth/staff";
import { templateRows } from "@/server/message-templates";
import { MergeFieldList, TemplateEditor } from "./editor";

export const metadata: Metadata = { title: "Client messages" };

export default async function MessagesPage() {
  await guardPage("/admin/messages");
  const rows = await templateRows();
  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <PageHeader
        title="Client messages"
        subtitle="The wording of confirmations, reminders and the texts Today suggests, for every shop. Texts only go to clients who opted in; marketing texts only to clients who agreed to marketing."
      />
      <MergeFieldList />
      {rows.map((r) => (
        <TemplateEditor key={r.kind} row={r} />
      ))}
    </div>
  );
}
