import { sparkPoints } from "@/domain/pph-card";

const W = 200;
const H = 64;

/**
 * A small line of daily values, 0 at the bottom, with a gap for a day with nothing (N/A) and the
 * last day marked. Each point's label and value are in its tooltip.
 */
export function Sparkline({ values, labels, shown, label }: { values: readonly (number | null)[]; labels: readonly string[]; shown: (v: number) => string; label: string }) {
  const pts = sparkPoints(values, W, H, 4);
  const runs: (typeof pts)[] = [];
  for (const p of pts) {
    const run = runs.at(-1);
    if (run && run.at(-1)!.i === p.i - 1) run.push(p);
    else runs.push([p]);
  }
  const last = pts.at(-1);
  if (!pts.length) return <p className="py-3 text-xs text-zinc-500">Nothing to chart yet.</p>;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="mt-1 h-16 w-full" role="img" aria-label={label} data-testid="pph-sparkline">
      <line x1={0} x2={W} y1={H - 4} y2={H - 4} className="stroke-zinc-200" strokeWidth={1} />
      {runs.map((run, j) =>
        run.length > 1 ? <polyline key={j} fill="none" className="stroke-zinc-900" strokeWidth={1.75} strokeLinejoin="round" points={run.map((p) => `${p.x},${p.y}`).join(" ")} /> : null,
      )}
      {pts.map((p) => (
        <circle key={p.i} cx={p.x} cy={p.y} r={p === last ? 3 : 1.75} className={p === last ? "fill-red-700" : "fill-zinc-900"}>
          <title>{`${labels[p.i]}: ${shown(values[p.i]!)}`}</title>
        </circle>
      ))}
    </svg>
  );
}
