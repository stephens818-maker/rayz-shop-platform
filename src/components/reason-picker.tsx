"use client";

import { MAX_NOTE, NEUTRAL_COLOR, PRIVATE_BLOCK_LABEL, PRIVATE_TIME_OFF_LABEL, reasonText } from "@/domain/block-reasons";
import { Field, Input, cx } from "./ui";

/** What a picker needs of a reason on the brand's list. */
export interface PickReason {
  id: string;
  label: string;
  color: string;
  private: boolean;
  countsAsLunch: boolean;
  noticeExempt: boolean;
}

export function ReasonDot({ color, className }: { color: string; className?: string }) {
  return <span aria-hidden className={cx("inline-block size-2.5 shrink-0 rounded-full", className)} style={{ backgroundColor: color || NEUTRAL_COLOR }} />;
}

/** A reason as the viewer was shown it, with the note on hover or tap (title). */
export function ReasonTag({ reason, className }: { reason: { label: string; color: string; note: string | null }; className?: string }) {
  return (
    <span title={reasonText(reason)} className={cx("inline-flex max-w-full items-center gap-1.5 rounded-full bg-zinc-50 px-2 py-0.5 text-xs font-medium text-zinc-800 ring-1 ring-inset ring-zinc-200", className)}>
      <ReasonDot color={reason.color} />
      <span className="truncate">{reason.label}</span>
    </span>
  );
}

export function ReasonPicker({
  reasons,
  value,
  onChange,
  note,
  onNote,
  label = "Reason",
  notePlaceholder = "e.g. Dentist, Chase on Main St.",
  timeOff = false,
}: {
  reasons: readonly PickReason[];
  value: string | null;
  onChange: (id: string) => void;
  note: string;
  onNote: (s: string) => void;
  label?: string;
  notePlaceholder?: string;
  timeOff?: boolean;
}) {
  const picked = reasons.find((r) => r.id === value);
  return (
    <div className="space-y-3">
      <div>
        <div className="mb-1.5 text-sm font-medium text-zinc-700">{label}</div>
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={label}>
          {reasons.map((r) => {
            const on = r.id === value;
            return (
              <button
                key={r.id}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => onChange(r.id)}
                className={cx(
                  "inline-flex h-10 items-center gap-2 rounded-full px-4 text-sm font-medium ring-1 ring-inset transition",
                  on ? "bg-ink-900 text-white ring-ink-900" : "bg-white text-zinc-900 ring-zinc-300 hover:bg-zinc-50",
                )}
              >
                <ReasonDot color={r.color} className={on ? "ring-2 ring-white" : undefined} />
                {r.label}
              </button>
            );
          })}
          {reasons.length === 0 && <p className="text-sm text-zinc-500">No reasons on the list yet. Ask a manager to add some.</p>}
        </div>
        {picked?.private && (
          <p className="mt-1.5 text-xs text-zinc-500">
            Private: coworkers see just &ldquo;{timeOff ? PRIVATE_TIME_OFF_LABEL : PRIVATE_BLOCK_LABEL}&rdquo;, and not the note. You and managers who can see private reasons see {picked.label}.
          </p>
        )}
      </div>
      <Field label="Note (optional, shown with the reason)">
        <Input value={note} maxLength={MAX_NOTE} onChange={(e) => onNote(e.target.value)} placeholder={notePlaceholder} />
      </Field>
    </div>
  );
}
