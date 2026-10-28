import { Notice } from "@/components/ui";
import { formatDate } from "@/lib/time";
import type { PayrollRange } from "./range";

/** Review only, which shops a pay period leaves out, and approve and lock waiting on every shop being shown. */
export function RangeNotices({ r }: { r: PayrollRange }) {
  if (!r.official)
    return (
      <div className="mb-4 space-y-2">
        <Notice tone="amber">
          <span data-testid="not-official">
            <strong>Not an official pay period.</strong> {r.heading} is a review only: approve and lock, adjustments and the iSolved files work on a full pay period of a pay group (pick one by
            number above; Dubuque runs on its own calendar). Overtime is still worked out per full Sunday–Saturday workweek
            {r.view?.review?.partialWeeks.length
              ? `, and ${r.view.review.partialWeeks.length === 1 ? "1 workweek is" : `${r.view.review.partialWeeks.length} workweeks are`} only partly in these dates (${r.view.review.partialWeeks.map((w) => `week of ${formatDate(w.weekStart, "MMM d")}`).join(", ")}): their overtime counts the whole week, and these dates get the part worked inside them.`
              : "."}
          </span>
        </Notice>
        {r.view?.review?.excluded.map((x) => (
          <Notice key={x.shopId} tone="blue">
            {x.shop} isn&apos;t in this review: {x.reason}. Pick one of its pay periods to see it.
          </Notice>
        ))}
      </div>
    );
  return (
    <div className="mb-4 space-y-2">
      {r.offCalendar.length > 0 && (
        <Notice tone="blue">
          {r.offCalendar.map((x) => x.shop).join(", ")} {r.offCalendar.length === 1 ? "is" : "are"} on another pay calendar, so these dates aren&apos;t one of {r.offCalendar.length === 1 ? "its" : "their"} pay periods and{" "}
          {r.offCalendar.length === 1 ? "it isn't" : "they aren't"} shown. Pick {r.offCalendar.length === 1 ? "its" : "their"} pay period by number to see {r.offCalendar.length === 1 ? "it" : "them"}.
        </Notice>
      )}
      {r.hidden > 0 && (
        <Notice tone="blue">
          Approve and lock covers every shop on this pay period ({r.full?.blocks.length}). {r.hidden === 1 ? "1 isn't" : `${r.hidden} aren't`} shown: show all of them to approve.
        </Notice>
      )}
    </div>
  );
}
