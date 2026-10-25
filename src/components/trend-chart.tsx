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
const COLOR = { main: "#18181b", brand: "#a1a1aa", alt: "#b91c1c" };
const colorOf = (s: TrendSeries) => (s.dashed ? COLOR.brand : s.tone === "alt" ? COLOR.alt : COLOR.main);

/** A line chart of rates (0 to 100%) by period. Gaps where a period has nothing; the same numbers are in the table below it. */
export function TrendChart({ id, title, labels, series }: { id: string; title: string; labels: string[]; series: TrendSeries[] }) {
  const n = labels.length;
  const x = (i: number) => PAD.l + (n <= 1 ? (W - PAD.l - PAD.r) / 2 : (i * (W - PAD.l - PAD.r)) / (n - 1));
  const y = (v: number) => PAD.t + (1 - Math.max(0, Math.min(1, v))) * (H - PAD.t - PAD.b);
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
                <line x1={PAD.l} x2={W - PAD.r} y1={y(g)} y2={y(g)} stroke="#e4e4e7" strokeWidth={1} />
                <text x={PAD.l - 6} y={y(g) + 4} textAnchor="end" fontSize={11} fill="#71717a">
                  {Math.round(g * 100)}%
                </text>
              </g>
            ))}
            {labels.map((l, i) =>
              i % every === 0 || i === n - 1 ? (
                <text key={i} x={x(i)} y={H - 8} textAnchor="middle" fontSize={11} fill="#71717a">
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
                      stroke={colorOf(s)}
                      strokeWidth={2}
                      strokeDasharray={s.dashed ? "5 4" : undefined}
                      points={run.map((p) => `${x(p.i)},${y(p.v)}`).join(" ")}
                    />
                  )}
                  {run.map((p) => (
                    <circle key={p.i} cx={x(p.i)} cy={y(p.v)} r={s.dashed ? 2 : 3} fill={colorOf(s)}>
                      <title>{`${labels[p.i]}: ${s.label} ${Math.round(p.v * 100)}%`}</title>
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
                <line x1="0" x2="18" y1="3" y2="3" stroke={colorOf(s)} strokeWidth={2} strokeDasharray={s.dashed ? "4 3" : undefined} />
              </svg>
              {s.label}
            </span>
          ))}
        </div>
      </div>
    </Card>
  );
}
