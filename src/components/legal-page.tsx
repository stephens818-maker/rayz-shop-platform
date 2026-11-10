import type { ReactNode } from "react";

export function LegalPage({ title, updated, children }: { title: string; updated?: string; children: ReactNode }) {
  return (
    <article className="mx-auto max-w-3xl rounded-xl bg-white p-6 text-[15px] leading-relaxed text-zinc-800 ring-1 ring-zinc-200 sm:p-8">
      <h1 className="text-2xl font-bold text-zinc-900">{title}</h1>
      {updated && <p className="mt-1 text-sm text-zinc-500">Last updated {updated}</p>}
      <div className="mt-6 space-y-4 [&_a]:text-brand-600 [&_a]:underline [&_h2]:mt-8 [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:text-zinc-900 [&_li]:ml-5 [&_li]:list-disc [&_ul]:space-y-1">{children}</div>
    </article>
  );
}
