import { Card, CardHeader } from "@/components/ui";

export interface TrendSeries {
  label: string;
  values: (number | null)[];
  dashed?: boolean;
  tone?: "alt";
}

const W = 720;
const H = 220;
const PAD = { l: 40, r: 12, t: 12, b: 28 };
const COLOR = { main: "var(--color-zinc-900)", brand: "var(--color-zinc-400)", alt: "var(--color-red-700)" };
const colorOf = (s: TrendSeries) => (s.dashed ? COLOR.brand : s.tone === "alt" ? COLOR.alt : COLOR.main);

/** A round top for a dollar axis: 1, 2, 2.5 or 5 times a power of ten, at or above the highest value. */
export function moneyAxisTop(maxCents: number): number {
  if (maxCents <= 0) return 100;
  const p = 10 ** Math.floor(Math.log10(maxCents));
  return ([1, 2, 2.5, 5, 10].find((m) => m * p >= maxCents) ?? 10) * p;
}

const dollarsOf = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { maximumFractionDigits: cents < 1000 ? 2 : 0 })}`;

/**
 * A line chart by period: rates (0 to 100%), or dollar amounts in cents on an axis from $0 to a round
 * top (`kind: "money"`). Gaps where a period has nothing; the same numbers are in the table below it.
 */
export function TrendChart({ id, title, labels, series, kind = "pct" }: { id: string; title: string; labels: string[]; series: TrendSeries[]; kind?: "pct" | "money" }) {
  const n = labels.length;
  const top = kind === "money" ? moneyAxisTop(Math.max(0, ...series.flatMap((s) => s.values.filter((v): v is number => v !== null)))) : 1;
  const tick = (g: number) => (kind === "money" ? dollarsOf(g * top) : `${Math.round(g * 100)}%`);
  const shown = (v: number) => (kind === "money" ? dollarsOf(v) : `${Math.round(v * 100)}%`);
  const x = (i: number) => PAD.l + (n <= 1 ? (W - PAD.l - PAD.r) / 2 : (i * (W - PAD.l - PAD.r)) / (n - 1));
  const y = (v: number) => PAD.t + (1 - Math.max(0, Math.min(1, v / top))) * (H - PAD.t - PAD.b);
  const every = Math.max(1, Math.ceil(n / 8));
  const runs = (vals: (number | null)[]) => {
    const out: { i: number; v: number }[][] = [];
    let cur: { i: number; v: number }[] = [];
    vals.forEach((v, i) => {
      if (v === null) {
        if (cur.length) out.push(cur);
        cur = [];
      } else cur.push({ i, v });
    });
    if (cur.length) out.push(cur);
    return out;
  };
  const empty = series.every((s) => s.values.every((v) => v === null));
  return (
    <Card className="mt-4" data-testid={`chart-${id}`}>
      <CardHeader title={title} />
      <div className="px-4 pb-3">
        {empty ? (
          <p className="py-6 text-center text-sm text-zinc-500">Nothing to chart in this range yet.</p>
        ) : (
          <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={title}>
            {[0, 0.25, 0.5, 0.75, 1].map((g) => (
              <g key={g}>
                <line x1={PAD.l} x2={W - PAD.r} y1={y(g * top)} y2={y(g * top)} className="stroke-zinc-200" strokeWidth={1} />
                <text x={PAD.l - 6} y={y(g * top) + 4} textAnchor="end" fontSize={11} className="fill-zinc-500">
                  {tick(g)}
                </text>
              </g>
            ))}
            {labels.map((l, i) =>
              i % every === 0 || i === n - 1 ? (
                <text key={i} x={x(i)} y={H - 8} textAnchor={n > 1 && i === n - 1 ? "end" : n > 1 && i === 0 ? "start" : "middle"} fontSize={11} className="fill-zinc-500">
                  {l.replace(/^Week of /, "")}
                </text>
              ) : null,
            )}
            {series.map((s) =>
              runs(s.values).map((run, j) => (
                <g key={`${s.label}-${j}`}>
                  {run.length > 1 && (
                    <polyline
                      fill="none"
                      style={{ stroke: colorOf(s) }}
                      strokeWidth={2}
                      strokeDasharray={s.dashed ? "5 4" : undefined}
                      points={run.map((p) => `${x(p.i)},${y(p.v)}`).join(" ")}
                    />
                  )}
                  {run.map((p) => (
                    <circle key={p.i} cx={x(p.i)} cy={y(p.v)} r={s.dashed ? 2 : 3} style={{ fill: colorOf(s) }}>
                      <title>{`${labels[p.i]}: ${s.label} ${shown(p.v)}`}</title>
                    </circle>
                  ))}
                </g>
              )),
            )}
          </svg>
        )}
        <div className="mt-1 flex flex-wrap gap-4 text-xs text-zinc-600">
          {series.map((s) => (
            <span key={s.label} className="inline-flex items-center gap-1.5">
              <svg width="18" height="6" aria-hidden>
                <line x1="0" x2="18" y1="3" y2="3" style={{ stroke: colorOf(s) }} strokeWidth={2} strokeDasharray={s.dashed ? "4 3" : undefined} />
              </svg>
              {s.label}
            </span>
          ))}
        </div>
      </div>
    </Card>
  );
}
