import type { Metadata } from "next";
import { Card, CardHeader } from "@/components/ui";
import { STEP_UP_ACTIONS, STEP_UP_LABEL, STEP_UP_MINUTES, type StepUpAction } from "@/domain/staff-auth";
import { stepUpFactor } from "@/server/auth/sign-in-guard";
import { guardPage } from "@/server/auth/staff";
import { VerifyForm } from "./verify-form";

export const metadata: Metadata = { title: "Confirm it's you" };

/** Before a download that needs a fresh sign-in (the client list export): confirm, then the download starts. */
export default async function VerifyPage({ searchParams }: { searchParams: Promise<{ for?: string; next?: string }> }) {
  const ctx = await guardPage("/admin/verify");
  const q = await searchParams;
  const action: StepUpAction = (STEP_UP_ACTIONS as readonly string[]).includes(q.for ?? "") ? (q.for as StepUpAction) : "export";
  const next = q.next && q.next.startsWith("/admin/") && !q.next.startsWith("//") ? q.next : "/admin";
  const factor = await stepUpFactor(ctx.staff.id);
  return (
    <div className="mx-auto max-w-md">
      <Card>
        <CardHeader
          title="Confirm it's you"
          subtitle={`To ${STEP_UP_LABEL[action]}, ${factor === "code" ? "enter the code from your authenticator app" : "enter your password"}. It counts for ${STEP_UP_MINUTES} minutes on this browser.`}
        />
        <div className="p-4 pt-0">
          <VerifyForm factor={factor} next={next} />
        </div>
      </Card>
    </div>
  );
}
