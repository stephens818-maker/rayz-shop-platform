import { Card, CardHeader } from "@/components/ui";
import type { BarChart } from "@/domain/report-charts";
import type { ColumnKind } from "@/domain/report-views";
import { formatCents } from "@/lib/money";

function fmt(kind: ColumnKind, v: number) {
  if (kind === "money") return formatCents(v);
  if (kind === "hours") return `${(v / 60).toFixed(1)} h`;
  return v.toLocaleString("en-US");
}

const W = 720;
const H = 200;
const PAD = { l: 8, r: 8, t: 8, b: 24 };

/** A report table's main number as bars: ranked (largest first) or over time. The table below has every row and the exact figures. */
export function BarChartCard({ chart }: { chart: BarChart }) {
  const max = Math.max(...chart.bars.map((b) => b.value), 1);
  const total = chart.bars.reduce((a, b) => a + Math.max(0, b.value), 0);
  return (
    <Card className="mt-4" data-testid={`bar-chart-${chart.id}`}>
      <CardHeader title={chart.title} subtitle={chart.subtitle} />
      {chart.shape === "rank" ? (
        <ol className="space-y-1.5 px-4 py-3" aria-label={chart.title}>
          {chart.bars.map((b) => (
            <li key={b.label} className="grid grid-cols-[minmax(6rem,11rem)_1fr_auto] items-center gap-3 text-sm">
              <span className="truncate text-zinc-700" title={b.label}>
                {b.label}
              </span>
              <span className="h-5 overflow-hidden rounded bg-zinc-100">
                <span
                  className="block h-full rounded bg-brand-600/85 transition-[width] duration-500"
                  style={{ width: `${(Math.max(0, b.value) / max) * 100}%` }}
                />
              </span>
              <span className="tabular w-24 text-right text-zinc-900">
                {fmt(chart.kind, b.value)}
                {total > 0 && chart.kind !== "hours" && <span className="ml-1 text-[11px] text-zinc-400">{Math.round((Math.max(0, b.value) / total) * 100)}%</span>}
              </span>
            </li>
          ))}
        </ol>
      ) : (
        <div className="px-4 pb-3">
          <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={chart.title}>
            {[0.25, 0.5, 0.75, 1].map((g) => (
              <line key={g} x1={PAD.l} x2={W - PAD.r} y1={PAD.t + (1 - g) * (H - PAD.t - PAD.b)} y2={PAD.t + (1 - g) * (H - PAD.t - PAD.b)} className="stroke-zinc-200" strokeWidth={1} />
            ))}
            {chart.bars.map((b, i) => {
              const n = chart.bars.length;
              const slot = (W - PAD.l - PAD.r) / n;
              const h = (Math.max(0, b.value) / max) * (H - PAD.t - PAD.b);
              const every = Math.max(1, Math.ceil(n / 10));
              return (
                <g key={i}>
                  <rect x={PAD.l + i * slot + slot * 0.15} y={H - PAD.b - h} width={slot * 0.7} height={Math.max(h, 0.5)} rx={Math.min(3, slot * 0.2)} className="fill-brand-600/85">
                    <title>{`${b.label}: ${fmt(chart.kind, b.value)}`}</title>
                  </rect>
                  {(i % every === 0 || i === n - 1) && (
                    <text x={PAD.l + i * slot + slot / 2} y={H - 6} textAnchor="middle" fontSize={11} className="fill-zinc-500">
                      {b.label.replace(/^Week of /, "").replace(/^\d{4}-/, "")}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
          <p className="text-xs text-zinc-500">Highest: {fmt(chart.kind, max)}</p>
        </div>
      )}
    </Card>
  );
}
