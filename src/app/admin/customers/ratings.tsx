"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button, Field, Select, Textarea, cx } from "@/components/ui";
import { RATING_NOTE_MAX } from "@/domain/ratings";
import { deleteRatingAction, rateVisitAction, updateRatingAction } from "./rating-actions";

type Mine = { id: string; stars: number; note: string | null } | null;

export function StarInput({ value, onChange, disabled }: { value: number; onChange: (n: number) => void; disabled?: boolean }) {
  const [hover, setHover] = useState(0);
  const shown = hover || value;
  return (
    <div className="flex gap-0.5" role="radiogroup" aria-label="Stars" onMouseLeave={() => setHover(0)}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          role="radio"
          aria-checked={value === n}
          aria-label={`${n} star${n === 1 ? "" : "s"}`}
          disabled={disabled}
          onMouseEnter={() => setHover(n)}
          onClick={() => onChange(n)}
          className={cx("text-2xl leading-none transition", n <= shown ? "text-amber-500" : "text-zinc-300", !disabled && "hover:scale-110")}
        >
          ★
        </button>
      ))}
    </div>
  );
}

export const Stars = ({ n }: { n: number }) => (
  <span className="text-amber-500" aria-label={`${n} of 5 stars`}>
    {"★".repeat(n)}
    <span className="text-zinc-300">{"★".repeat(5 - n)}</span>
  </span>
);

function useSave() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const run = (fn: () => Promise<{ ok: true } | { ok: false; error: string }>, ok: string) =>
    start(async () => {
      const r = await fn();
      setMsg(r.ok ? { ok: true, text: ok } : { ok: false, text: r.error });
      if (r.ok) router.refresh();
    });
  return { pending, msg, setMsg, run };
}

const NOTE_HINT = "Private to staff. For example: late, great tipper, difficult.";

export interface VisitOption {
  key: string;
  appointmentId: string | null;
  saleId: string | null;
  label: string;
  myRating: Mine;
}

export function RateVisitForm({ customerId, visits }: { customerId: string; visits: VisitOption[] }) {
  const [key, setKey] = useState(visits[0]?.key ?? "");
  const visit = visits.find((v) => v.key === key);
  const [stars, setStars] = useState(visit?.myRating?.stars ?? 0);
  const [note, setNote] = useState(visit?.myRating?.note ?? "");
  const { pending, msg, setMsg, run } = useSave();
  if (!visits.length) return <p className="px-4 py-3 text-xs text-zinc-500">No visits you can rate yet.</p>;
  const pick = (k: string) => {
    const v = visits.find((x) => x.key === k);
    setKey(k);
    setStars(v?.myRating?.stars ?? 0);
    setNote(v?.myRating?.note ?? "");
    setMsg(null);
  };
  return (
    <div className="space-y-3 border-t border-zinc-100 p-4">
      <Field label="Visit">
        <Select value={key} onChange={(e) => pick(e.target.value)}>
          {visits.map((v) => (
            <option key={v.key} value={v.key}>
              {v.label}
              {v.myRating ? ` · you gave ${v.myRating.stars}★` : ""}
            </option>
          ))}
        </Select>
      </Field>
      <StarInput value={stars} onChange={setStars} disabled={pending} />
      <Field label="Private note (optional)" hint={NOTE_HINT}>
        <Textarea rows={2} maxLength={RATING_NOTE_MAX} value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
      <div className="flex items-center gap-3">
        <Button
          size="sm"
          disabled={pending || !stars || !visit}
          onClick={() => run(() => rateVisitAction({ customerId, appointmentId: visit!.appointmentId, saleId: visit!.saleId, stars, note }), visit!.myRating ? "Rating updated" : "Rating saved")}
        >
          {visit?.myRating ? "Update my rating" : "Save rating"}
        </Button>
        {msg && <span className={cx("text-xs", msg.ok ? "text-emerald-700" : "text-red-600")}>{msg.text}</span>}
      </div>
    </div>
  );
}

export interface HistoryRow {
  id: string;
  stars: number;
  note: string | null;
  ratedBy: string;
  when: string;
  edited: boolean;
  shop: string;
  visit: string;
  visitHref: string | null;
  mine: boolean;
}

export function RatingHistory({ rows, canRemoveAny }: { rows: HistoryRow[]; canRemoveAny: boolean }) {
  return (
    <ul className="divide-y divide-zinc-100 text-sm">
      {rows.map((r) => (
        <HistoryItem key={r.id} row={r} canRemove={r.mine || canRemoveAny} />
      ))}
    </ul>
  );
}

function HistoryItem({ row, canRemove }: { row: HistoryRow; canRemove: boolean }) {
  const [editing, setEditing] = useState(false);
  const [stars, setStars] = useState(row.stars);
  const [note, setNote] = useState(row.note ?? "");
  const { pending, msg, run } = useSave();
  return (
    <li className="px-4 py-2.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Stars n={row.stars} />
            <span className="font-medium">{row.ratedBy}</span>
            {row.mine && <span className="text-[11px] text-zinc-500">(you)</span>}
          </div>
          <div className="text-xs text-zinc-500">
            {row.when}
            {row.edited && " · edited"} · {row.shop} ·{" "}
            {row.visitHref ? (
              <a className="underline" href={row.visitHref}>
                {row.visit}
              </a>
            ) : (
              row.visit
            )}
          </div>
          {row.note && !editing && <p className="mt-1 whitespace-pre-line text-xs text-zinc-700">{row.note}</p>}
        </div>
        <div className="flex shrink-0 gap-2 text-xs">
          {row.mine && !editing && (
            <button className="underline" onClick={() => setEditing(true)}>
              Edit
            </button>
          )}
          {canRemove && !editing && (
            <button className="text-red-600 underline" disabled={pending} onClick={() => confirm("Remove this rating?") && run(() => deleteRatingAction(row.id), "Removed")}>
              Remove
            </button>
          )}
        </div>
      </div>
      {editing && (
        <div className="mt-2 space-y-2">
          <StarInput value={stars} onChange={setStars} disabled={pending} />
          <Textarea rows={2} maxLength={RATING_NOTE_MAX} value={note} onChange={(e) => setNote(e.target.value)} placeholder={NOTE_HINT} />
          <div className="flex gap-2">
            <Button size="sm" disabled={pending} onClick={() => run(async () => { const r = await updateRatingAction(row.id, { stars, note }); if (r.ok) setEditing(false); return r; }, "Updated")}>
              Save
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {msg && !msg.ok && <p className="mt-1 text-xs text-red-600">{msg.text}</p>}
    </li>
  );
}

/** Rate the client right after checkout, from the receipt. */
export function QuickRate({ customerId, firstName, appointmentId, saleId, myRating }: { customerId: string; firstName: string; appointmentId: string | null; saleId: string; myRating: Mine }) {
  const [stars, setStars] = useState(myRating?.stars ?? 0);
  const [note, setNote] = useState(myRating?.note ?? "");
  const { pending, msg, run } = useSave();
  return (
    <div className="space-y-2 rounded-xl bg-white p-4 ring-1 ring-zinc-200">
      <div className="text-sm font-semibold">Rate {firstName} for this visit</div>
      <p className="text-xs text-zinc-500">Staff only. Clients never see ratings.</p>
      <StarInput value={stars} onChange={setStars} disabled={pending} />
      <Textarea rows={2} maxLength={RATING_NOTE_MAX} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Private note (optional): late, great tipper…" />
      <div className="flex items-center gap-3">
        <Button size="sm" disabled={pending || !stars} onClick={() => run(() => rateVisitAction({ customerId, appointmentId, saleId, stars, note }), myRating ? "Rating updated" : "Rating saved")}>
          {myRating ? "Update rating" : "Save rating"}
        </Button>
        {msg && <span className={cx("text-xs", msg.ok ? "text-emerald-700" : "text-red-600")}>{msg.text}</span>}
      </div>
    </div>
  );
}
