import type { Metadata } from "next";
import Link from "next/link";
import { Card, CardHeader, Empty, PageHeader } from "@/components/ui";
import { formatDate } from "@/lib/time";
import { guardPage } from "@/server/auth/staff";
import { clientPolicy, recordClientAccess } from "@/server/client-privacy";
import { HELP_REASON_LABEL, helpRequests } from "@/server/identity-help";
import { NoCopy } from "../privacy";
import { CloseRequest } from "./client";

export const metadata: Metadata = { title: "App sign-in help" };

export default async function SignInHelpPage() {
  const ctx = await guardPage("/admin/customers/sign-in-help");
  await recordClientAccess(ctx, { kind: "list", detail: { via: "sign_in_help" } });
  const policy = await clientPolicy(ctx);
  const open = await helpRequests("open");
  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <PageHeader
        title="App sign-in help"
        subtitle="Clients who couldn't sign in to the app or website. Phone numbers get reassigned, so check it's really them (in person or by calling the number on their profile) before you confirm a profile. Confirming unlocks its rewards and lets its number sign in again. If they have two profiles, merge them on the duplicates page."
      />
      {open.length === 0 && <Empty title="No open requests" />}
      <NoCopy what="sign-in requests">
        <div className="space-y-3">
          {open.map((r) => (
            <Card key={r.id}>
              <CardHeader
                title={`${r.firstName} ${r.lastName ?? ""}`.trim()}
                subtitle={`${HELP_REASON_LABEL[r.reason]} · ${formatDate(r.createdAt, "MMM d, h:mm a")}`}
              />
              <div className="grid gap-4 p-4 md:grid-cols-2">
                <div className="space-y-1 text-sm">
                  {r.phone && <div>Phone: {policy.show("phone", r.phone)}</div>}
                  {r.email && <div>Email: {policy.show("email", r.email)}</div>}
                  {r.message && <div className="text-zinc-600">&ldquo;{r.message}&rdquo;</div>}
                  {r.candidates.length > 0 && (
                    <div className="pt-2">
                      <div className="text-xs font-medium uppercase text-zinc-500">Profiles on this number</div>
                      <ul className="mt-1 space-y-0.5">
                        {r.candidates.map((c) => (
                          <li key={c.id}>
                            <Link className="text-brand-600 underline" href={`/admin/customers/${c.id}`}>
                              {c.firstName} {c.lastName ?? ""}
                            </Link>
                            {c.source === "Squire import" && <span className="text-xs text-zinc-500"> · imported</span>}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
                <CloseRequest id={r.id} candidates={r.candidates.map((c) => ({ id: c.id, label: c.firstName }))} />
              </div>
            </Card>
          ))}
        </div>
      </NoCopy>
    </div>
  );
}
