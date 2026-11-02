import type { Metadata } from "next";
import { Card, PageHeader } from "@/components/ui";
import { handbookFor } from "@/domain/handbook";
import { guardPage } from "@/server/auth/staff";

export const metadata: Metadata = { title: "Handbook" };

export default async function HelpPage() {
  const ctx = await guardPage("/admin/help");
  const topics = handbookFor(ctx.permissions);
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="Handbook" subtitle="Short steps for the screens you can open. Search also finds these." />
      <div className="space-y-4">
        {topics.map((t) => (
          <Card key={t.slug}>
            <article id={t.slug} className="scroll-mt-4 p-4">
              <h2 className="text-base font-semibold text-zinc-900">{t.title}</h2>
              <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-zinc-700">
                {t.steps.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
            </article>
          </Card>
        ))}
      </div>
    </div>
  );
}
