import Link from "next/link";
import { Card, cx } from "@/components/ui";
import type { Block, DocSection, MorningDoc, Tone, Tile } from "@/domain/morning-render";

const CHIP: Record<Tone, string> = { good: "bg-emerald-50 text-emerald-700", bad: "bg-red-50 text-red-700", neutral: "bg-zinc-100 text-zinc-600" };
const DOT = { high: "bg-red-600", medium: "bg-amber-600", low: "bg-zinc-300" } as const;

function Chip({ text, tone }: { text: string; tone: Tone }) {
  return <span className={cx("inline-block whitespace-nowrap rounded-full px-1.5 py-px text-[11px] font-semibold", CHIP[tone])}>{text}</span>;
}

function TileCard({ t }: { t: Tile }) {
  return (
    <Card className="p-4">
      <div className="text-[11px] uppercase tracking-wide text-zinc-500">{t.label}</div>
      <div className="mt-1 flex items-baseline gap-2">
        <span className="text-2xl font-bold text-zinc-900">{t.value}</span>
        <Chip text={t.change} tone={t.tone} />
      </div>
      <div className="mt-1 text-xs text-zinc-500">{t.sub}</div>
    </Card>
  );
}

function BlockView({ b }: { b: Block }) {
  switch (b.kind) {
    case "metrics":
      return (
        <div className="overflow-x-auto">
          <table className="w-full text-xs sm:text-sm">
            <thead>
              <tr className="text-[11px] text-zinc-400">
                <th className="py-1 text-left font-normal" />
                <th className="px-2 py-1 text-right font-normal">Day</th>
                <th />
                <th className="px-2 py-1 text-right font-normal">Week to date</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {b.rows.map((r) => (
                <tr key={r.label} className="border-t border-zinc-100">
                  <td className={cx("py-1.5", r.label.startsWith(" ") ? "pl-3 text-zinc-500" : "text-zinc-900")}>{r.label.trim()}</td>
                  <td className="whitespace-nowrap px-1 py-1.5 text-right font-semibold tabular-nums sm:px-2">{r.day}</td>
                  <td className="py-1.5 text-right">
                    <Chip text={r.dayChange} tone={r.dayTone} />
                  </td>
                  <td className="whitespace-nowrap px-1 py-1.5 text-right tabular-nums text-zinc-700 sm:px-2">{r.wtd}</td>
                  <td className="py-1.5 text-right">
                    <Chip text={r.wtdChange} tone={r.wtdTone} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "table":
      return (
        <div className="mt-3">
          {b.title && <div className="mb-1 text-sm font-semibold text-zinc-900">{b.title}</div>}
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-zinc-100 text-[11px] text-zinc-400">
                  {b.columns.map((c, i) => (
                    <th key={c} className={cx("px-1.5 py-1 font-normal", b.numeric[i] ? "text-right" : "text-left")}>
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {b.rows.map((r, j) => (
                  <tr key={j} className="border-b border-zinc-50">
                    {r.map((c, i) => (
                      <td key={i} className={cx("px-1.5 py-1.5", i === 0 ? "text-zinc-900" : "text-zinc-600", b.numeric[i] && "whitespace-nowrap text-right tabular-nums")}>
                        {c}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      );
    case "bars": {
      const max = Math.max(1, ...b.rows.map((r) => Math.max(r.value, r.prior ?? 0)));
      const w = (v: number) => `${Math.max(0, Math.min(100, (v / max) * 100))}%`;
      return (
        <div className="mt-3">
          <div className="mb-1 flex flex-wrap items-center gap-3 text-sm font-semibold text-zinc-900">
            {b.title}
            {b.legend && (
              <span className="flex items-center gap-2 text-[11px] font-normal text-zinc-400">
                <span className="inline-block size-2 bg-zinc-900" /> {b.legend[0]}
                <span className="inline-block size-2 bg-zinc-300" /> {b.legend[1]}
              </span>
            )}
          </div>
          <div className="space-y-1.5" role="list">
            {b.rows.map((r) => (
              <div key={r.label} role="listitem" className="grid grid-cols-[5.5rem_1fr_auto] items-center gap-2 text-xs sm:grid-cols-[7rem_1fr_auto]">
                <span className="truncate text-zinc-600">{r.label}</span>
                <span className="space-y-0.5">
                  <span className="block h-2 rounded-sm bg-zinc-900" style={{ width: w(r.value) }} />
                  {r.prior !== undefined && <span className="block h-1 rounded-sm bg-zinc-300" style={{ width: w(r.prior) }} />}
                </span>
                <span className="whitespace-nowrap text-right tabular-nums text-zinc-900">{r.valueLabel}</span>
              </div>
            ))}
          </div>
        </div>
      );
    }
    case "list":
      return (
        <div className="mt-3">
          {b.title && <div className="mb-1 text-sm font-semibold text-zinc-900">{b.title}</div>}
          <ul className="divide-y divide-zinc-100">
            {b.items.map((i, k) => (
              <li key={k} className="flex gap-2 py-1.5 text-sm">
                <span className={cx("mt-1.5 size-2 shrink-0 rounded-full", DOT[i.severity ?? "low"])} aria-label={i.severity === "high" ? "Urgent" : undefined} />
                <span>
                  {i.href ? (
                    <Link href={i.href} className="text-zinc-900 hover:underline">
                      {i.title}
                    </Link>
                  ) : (
                    i.title
                  )}
                  {i.detail && <span className="block text-xs text-zinc-500">{i.detail}</span>}
                </span>
              </li>
            ))}
          </ul>
        </div>
      );
    case "note":
      return <p className="mt-2 text-xs text-zinc-500">{b.text}</p>;
  }
}

function SectionCard({ s }: { s: DocSection }) {
  return (
    <Card className="min-w-0 p-4" id={s.key}>
      <div className="flex items-start justify-between gap-3">
        <h2 className="text-base font-semibold text-zinc-900">{s.title}</h2>
        {s.link && (
          <Link href={s.link.href} className="whitespace-nowrap text-xs font-semibold text-amber-700 hover:underline">
            {s.link.label} ›
          </Link>
        )}
      </div>
      {s.subtitle && <p className="mt-0.5 text-xs text-zinc-500">{s.subtitle}</p>}
      <div className="mt-2">
        {s.blocks.map((b, i) => (
          <BlockView key={i} b={b} />
        ))}
      </div>
    </Card>
  );
}

/** The dashboard's tiles and sections, laid out like the email but two columns wide on a desktop. */
export function MorningDocView({ doc }: { doc: MorningDoc }) {
  const wide = (s: DocSection) => s.key === "exceptions" || s.key === "today";
  const lead = doc.sections.filter(wide);
  const others = doc.sections.filter((s) => !wide(s));
  return (
    <div className="space-y-4">
      {doc.tiles.length > 0 && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {doc.tiles.map((t) => (
            <TileCard key={t.label} t={t} />
          ))}
        </div>
      )}
      {lead.map((s) => (
        <SectionCard key={s.key} s={s} />
      ))}
      <div className="grid gap-4 lg:grid-cols-2">
        {others.map((s) => (
          <SectionCard key={s.key} s={s} />
        ))}
      </div>
    </div>
  );
}
