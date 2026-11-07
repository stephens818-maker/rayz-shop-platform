"use client";

import { Field, Input } from "@/components/ui";
import { GOOGLE_REVIEW_HELP, googleReviewLink, ordinal, type ReviewFollowUp, type ReviewRules } from "@/domain/reviews";

export interface ReviewValue {
  reviewUrl: string;
  reviewFollowUp: ReviewFollowUp;
  reviewMinVisits: number | null;
  reviewSnoozeDays: number | null;
}

const intOr = (s: string, d: number) => (/^\d+$/.test(s) ? Number(s) : d);
const intOrBrand = (s: string, d: number | null) => (s.trim() === "" ? null : /^\d+$/.test(s.trim()) ? Number(s.trim()) : d);

/**
 * The location's Google review link (with what it'll be saved as), from which visit it's shown and the
 * pause after a tap (blank: the brand's), and the optional follow-up after a visit.
 */
export function ReviewFields({ value, onChange, brand }: { value: ReviewValue; onChange: (v: ReviewValue) => void; brand: ReviewRules }) {
  const link = googleReviewLink(value.reviewUrl);
  const f = value.reviewFollowUp;
  const from = value.reviewMinVisits ?? brand.minVisits;
  const pause = value.reviewSnoozeDays ?? brand.snoozeDays;
  const setF = (p: Partial<ReviewFollowUp>) => onChange({ ...value, reviewFollowUp: { ...f, ...p } });
  return (
    <div className="grid gap-3 sm:col-span-2 sm:grid-cols-2" data-testid="review-fields">
      <Field label="Google review link" hint={`${GOOGLE_REVIEW_HELP}. Blank hides "Leave a review" on receipts.`} className="sm:col-span-2">
        <Input
          inputMode="url"
          maxLength={600}
          placeholder="g.page/r/…/review, or ChIJ…"
          value={value.reviewUrl}
          onChange={(e) => onChange({ ...value, reviewUrl: e.target.value })}
          data-testid="google-review-link"
        />
      </Field>
      <p className="text-xs sm:col-span-2" data-testid="google-review-preview">
        {!link.ok ? (
          <span className="text-red-600">{link.message}</span>
        ) : link.url ? (
          <>
            <span className="text-zinc-500">Clients go to </span>
            <a className="break-all underline" href={link.url} target="_blank" rel="noopener noreferrer">
              {link.url}
            </a>
          </>
        ) : (
          <span className="text-zinc-500">No link: receipts don&apos;t show Leave a review.</span>
        )}
      </p>
      {link.ok && link.url && (
        <>
          <Field label="Show Leave a review from visit" hint={`Blank: the brand's (visit ${brand.minVisits}). Completed visits at any location; 1 shows it to everyone.`}>
            <Input
              type="number"
              min={1}
              max={50}
              placeholder={String(brand.minVisits)}
              value={value.reviewMinVisits === null ? "" : String(value.reviewMinVisits)}
              onChange={(e) => onChange({ ...value, reviewMinVisits: intOrBrand(e.target.value, value.reviewMinVisits) })}
              data-testid="review-min-visits"
            />
          </Field>
          <Field label="After a tap, don't ask again for (days)" hint={`Blank: the brand's (${brand.snoozeDays} days). 0 never pauses.`}>
            <Input
              type="number"
              min={0}
              max={365}
              placeholder={String(brand.snoozeDays)}
              value={value.reviewSnoozeDays === null ? "" : String(value.reviewSnoozeDays)}
              onChange={(e) => onChange({ ...value, reviewSnoozeDays: intOrBrand(e.target.value, value.reviewSnoozeDays) })}
              data-testid="review-snooze-days"
            />
          </Field>
          <p className="text-xs text-zinc-500 sm:col-span-2" data-testid="review-rule-summary">
            {from <= 1 ? "Every client's receipt" : `Receipts from a client's ${ordinal(from)} visit on`} {from <= 1 ? "shows" : "show"} Leave a review
            {pause > 0 ? `, except for ${pause} days after they tap this location's link on another receipt` : ""}. Based only on the visit count, never on how the visit went.
          </p>
        </>
      )}
      <label className="flex items-start gap-2 text-sm text-zinc-700 sm:col-span-2">
        <input type="checkbox" className="mt-1" checked={f.enabled} disabled={!link.ok || !link.url} onChange={(e) => setF({ enabled: e.target.checked })} data-testid="review-follow-up" />
        <span>
          Text or email the review link after the visit
          <span className="block text-xs text-zinc-500">
            From the same visit as the receipt button, only to clients who agreed to texts or emails, never to a number that replied STOP or an email that
            turned them off, and not in quiet hours. Who&apos;s asked depends only on the visit count and consent, and everyone gets the same message: asking
            only happy clients is against Google&apos;s policy.
          </span>
        </span>
      </label>
      {f.enabled && (
        <>
          <Field label="Hours after paying" hint="1 to 48.">
            <Input type="number" min={1} max={48} value={String(f.delayHours)} onChange={(e) => setF({ delayHours: intOr(e.target.value, f.delayHours) })} />
          </Field>
          <Field label="Ask the same client again after (days)" hint="0 asks after every visit.">
            <Input type="number" min={0} max={365} value={String(f.repeatDays)} onChange={(e) => setF({ repeatDays: intOr(e.target.value, f.repeatDays) })} />
          </Field>
        </>
      )}
    </div>
  );
}
