import { Notice } from "@/components/ui";
import { formatDate } from "@/lib/time";
import { workweekProblem } from "@/domain/report-range";
import type { PayrollRange } from "./range";

/** Review only, a run of whole workweeks, which shops a pay period leaves out, an overlap with a locked run, and approve and lock waiting on every shop being shown. */
export function RangeNotices({ r }: { r: PayrollRange }) {
  const excluded = r.view?.excluded ?? [];
  const partial = r.view?.review?.partialWeeks ?? [];
  const why = workweekProblem(r.range.from, r.range.to);
  return (
    <div className="mb-4 space-y-2">
      {r.kind === "review" && (
        <Notice tone="amber">
          <span data-testid="not-official">
            <strong>Not an official pay period.</strong> {r.heading} is a review only: approve, lock and the iSolved files need a pay period or whole Sunday–Saturday workweeks in America/Chicago
            {why ? `, and these dates ${why}` : ""}. Pick a pay period above (Dubuque runs on its own calendar), or dates from a Sunday to a Saturday. Overtime is still worked out per full Sunday–Saturday workweek
            {partial.length ? (
              <>
                , and{" "}
                <span data-testid="partial-weeks">
                  {partial.length === 1 ? "1 workweek is" : `${partial.length} workweeks are`} only partly in these dates ({partial.map((w) => `week of ${formatDate(w.weekStart, "MMM d")}`).join(", ")})
                </span>
                : their overtime counts the whole week, and the O.T. hours shown for days in these dates are an <strong>estimate</strong> (marked est.).
              </>
            ) : (
              "."
            )}
          </span>
        </Notice>
      )}
      {r.kind === "weeks" && (
        <Notice tone="blue">
          <span data-testid="weeks-run">
            <strong>Whole workweeks, not a pay period.</strong> {r.heading} runs Sunday to Saturday, so it can be approved, locked and exported for the shops shown ({r.full?.blocks.map((b) => b.shop).join(", ")}). A pay period is the usual run:
            adjustments, late commission and final pay are entered on one, and the iSolved file has no period number (00).
          </span>
        </Notice>
      )}
      {r.overlap && (
        <Notice tone="red">
          <span data-testid="lock-overlap">{r.overlap}</span>
        </Notice>
      )}
      {excluded.map((x) => (
        <Notice key={x.shopId} tone="blue">
          {x.shop} isn&apos;t in {r.kind === "review" ? "this review" : "these dates"}: {x.reason}. Pick one of its pay periods to see it.
        </Notice>
      ))}
      {r.offCalendar.length > 0 && (
        <Notice tone="blue">
          {r.offCalendar.map((x) => x.shop).join(", ")} {r.offCalendar.length === 1 ? "is" : "are"} on another pay calendar, so these dates aren&apos;t one of {r.offCalendar.length === 1 ? "its" : "their"} pay periods and{" "}
          {r.offCalendar.length === 1 ? "it isn't" : "they aren't"} shown. Pick {r.offCalendar.length === 1 ? "its" : "their"} pay period by number to see {r.offCalendar.length === 1 ? "it" : "them"}.
        </Notice>
      )}
      {r.hidden > 0 && (
        <Notice tone="blue">
          Approve and lock covers every shop on this pay period ({r.full?.blocks.length}). {r.hidden === 1 ? "1 isn't" : `${r.hidden} aren't`} shown here; approving approves them too.
        </Notice>
      )}
    </div>
  );
}
