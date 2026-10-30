import Link from "next/link";
import { cx } from "@/components/ui";
import type { NoteBrief } from "@/domain/client-notes";
import { PinIcon } from "./pin-icon";

/**
 * A client's pinned notes and latest cut note, wherever they turn up: the calendar, Today,
 * check-in and checkout. With client notes masked, only how many there are.
 */
export function ClientNotesBrief({ brief, customerId, compact, className }: { brief: NoteBrief | null | undefined; customerId?: string | null; compact?: boolean; className?: string }) {
  if (!brief || !brief.count) return null;
  const more = customerId ? (
    <Link href={`/admin/customers/${customerId}`} className="text-xs underline">
      All notes ({brief.count})
    </Link>
  ) : null;
  if (brief.masked) {
    return (
      <p className={cx("text-xs text-zinc-500", className)}>
        {brief.count} note{brief.count === 1 ? "" : "s"} on file
      </p>
    );
  }
  return (
    <div className={cx("space-y-1.5 text-sm", className)} data-client-notes>
      {brief.pinned.map((p) => (
        <div key={p.id} className="flex gap-1.5 rounded-md bg-amber-50 px-2 py-1 text-amber-950">
          <PinIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" title={p.kind === "private" ? "Pinned private note" : "Pinned note"} />
          <div className="min-w-0">
            <p className={cx("whitespace-pre-wrap", compact && "line-clamp-2")}>
              {p.kind === "private" && <span className="mr-1 text-[11px] font-semibold uppercase text-amber-700">Private</span>}
              {p.body}
            </p>
            {!compact && <p className="text-[11px] text-amber-800/70">{p.credit}</p>}
          </div>
        </div>
      ))}
      {brief.cut && (
        <div className="rounded-md bg-zinc-50 px-2 py-1">
          <p className="text-[11px] font-semibold uppercase text-zinc-500">Last cut</p>
          {brief.cut.details && <p className="font-medium text-zinc-800">{brief.cut.details}</p>}
          {brief.cut.body && <p className={cx("whitespace-pre-wrap text-zinc-700", compact && "line-clamp-2")}>{brief.cut.body}</p>}
          {!compact && <p className="text-[11px] text-zinc-500">{brief.cut.credit}</p>}
        </div>
      )}
      {more}
    </div>
  );
}
