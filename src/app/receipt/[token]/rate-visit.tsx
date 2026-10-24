"use client";

import { useState, useTransition } from "react";
import { rateVisitAction } from "./actions";

/** "How was your visit?" one to five, once per visit. */
export function RateVisit({
  token,
  initial,
  accent,
}: {
  token: string;
  initial: number | null;
  accent: string;
}) {
  const [stars, setStars] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <div
      className="rounded-xl bg-zinc-50 p-4 text-center text-sm"
      data-testid="rate-visit"
    >
      <p className="font-semibold text-zinc-900">
        {stars ? "Thanks for rating your visit" : "How was your visit?"}
      </p>
      <div
        className="mt-2 flex justify-center gap-1"
        role="radiogroup"
        aria-label="Rate your visit from 1 to 5"
      >
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={stars === n}
            aria-label={`${n} star${n === 1 ? "" : "s"}`}
            disabled={pending || stars !== null}
            className="text-3xl leading-none disabled:cursor-default"
            style={{ color: stars !== null && n <= stars ? accent : "#d4d4d8" }}
            onClick={() =>
              start(async () => {
                setError(null);
                const r = await rateVisitAction(token, n);
                if (r.ok) setStars(r.data.stars);
                else setError(r.error);
              })
            }
          >
            ★
          </button>
        ))}
      </div>
      {error && <p className="mt-1 text-red-700">{error}</p>}
    </div>
  );
}
