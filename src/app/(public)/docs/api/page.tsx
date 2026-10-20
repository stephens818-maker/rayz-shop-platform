import type { Metadata } from "next";
import { openApiDocument } from "@/server/openapi";

export const metadata: Metadata = { title: "API v1" };

const METHOD_TONE: Record<string, string> = {
  get: "bg-sky-100 text-sky-800",
  post: "bg-emerald-100 text-emerald-800",
  patch: "bg-amber-100 text-amber-800",
};

export default function ApiDocs() {
  const doc = openApiDocument(process.env.APP_BASE_URL ?? "http://localhost:3000");
  type Op = { tags?: string[]; summary?: string; description?: string; security?: unknown[] };
  const ops = Object.entries(doc.paths).flatMap(([path, methods]) =>
    Object.entries(methods as Record<string, Op>).map(([method, op]) => ({ path, method, op })),
  );
  const tags = [...new Set(ops.map((o) => o.op.tags?.[0] ?? "Other"))];
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">{doc.info.title}</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Version {doc.info.version} · Base URL <code className="rounded bg-zinc-100 px-1">{doc.servers[0].url}</code> ·{" "}
          <a className="text-brand-600 underline" href="/api/v1/openapi.json">
            openapi.json
          </a>
        </p>
        <pre className="mt-4 whitespace-pre-wrap rounded-xl bg-white p-4 text-sm text-zinc-700 ring-1 ring-zinc-200">{doc.info.description}</pre>
      </div>
      {tags.map((tag) => (
        <section key={tag}>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-500">{tag}</h2>
          <div className="divide-y divide-zinc-100 rounded-xl bg-white ring-1 ring-zinc-200">
            {ops
              .filter((o) => (o.op.tags?.[0] ?? "Other") === tag)
              .map((o) => (
                <div key={o.method + o.path} className="flex flex-wrap items-start gap-3 px-4 py-3">
                  <span className={`w-14 rounded px-1.5 py-0.5 text-center font-mono text-xs font-bold uppercase ${METHOD_TONE[o.method]}`}>{o.method}</span>
                  <code className="font-mono text-sm">{o.path}</code>
                  <span className="flex-1 text-sm text-zinc-600">
                    {o.op.summary}
                    {o.op.description && <span className="block text-xs text-zinc-400">{o.op.description}</span>}
                  </span>
                  {o.op.security && JSON.stringify(o.op.security).includes("bearerAuth") && (
                    <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs text-zinc-600">{JSON.stringify(o.op.security).includes("{}") ? "bearer optional" : "bearer"}</span>
                  )}
                </div>
              ))}
          </div>
        </section>
      ))}
    </div>
  );
}
