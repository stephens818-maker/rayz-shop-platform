import type { Metadata } from "next";
import { PageHeader } from "@/components/ui";
import { guardPage } from "@/server/auth/staff";
import { listReasons } from "@/server/block-reasons";
import { ReasonsEditor } from "./editor";

export const metadata: Metadata = { title: "Block reasons" };

export default async function BlockReasonsPage() {
  await guardPage("/admin/block-reasons");
  const reasons = await listReasons();
  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <PageHeader
        title="Block reasons"
        subtitle="Every block and time off entry gets one of these, plus an optional note. The calendar writes the reason on the block in its color. Customers booking online never see reasons, only that the time is taken."
      />
      <ReasonsEditor reasons={reasons} />
    </div>
  );
}
