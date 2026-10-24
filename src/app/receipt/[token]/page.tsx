import type { Metadata } from "next";
import Link from "next/link";
import { personHeading } from "@/domain/receipts";
import { formatCents } from "@/lib/money";
import { formatPhone } from "@/lib/phone";
import { formatDate, formatDateTime } from "@/lib/time";
import { resolveReceipt } from "@/server/receipts";
import { StopEmails } from "./stop-emails";

export const metadata: Metadata = { title: "Your receipt", robots: { index: false, follow: false }, referrer: "no-referrer" };
export const dynamic = "force-dynamic";

/**
 * The digital receipt, from the link in the text or email. The token is the only credential, and the
 * page shows the ticket as it is now (refunds and voids included), with no card number or contact details.
 */
export default async function ReceiptPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const r = await resolveReceipt(token);
  if (r.state !== "ok")
    return (
      <Shell accent={null}>
        <div className="space-y-3 rounded-2xl bg-white p-6 text-center ring-1 ring-zinc-200">
          <h1 className="text-xl font-bold">This receipt link doesn&apos;t work</h1>
          <p className="text-zinc-600">Check that you opened the whole link from the text or email.</p>
          <Link className="inline-flex h-11 items-center rounded-xl bg-zinc-900 px-5 text-sm font-semibold text-white" href="/receipt">
            Get a copy of a receipt
          </Link>
        </div>
      </Shell>
    );
  const d = r.data;
  const accent = d.shop.accentColor ?? "#c81e1e";
  const voided = d.sale.status === "voided";
  const refunded = !voided && d.refundedCents > 0;
  return (
    <Shell accent={accent}>
      <article className="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-zinc-200" data-testid="receipt">
        <header className="px-5 pb-4 pt-6 text-center">
          {d.shop.logoUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={d.shop.logoUrl} alt="" className="mx-auto mb-3 h-14 w-14 object-contain" />
          )}
          <h1 className="text-lg font-bold leading-tight">{d.shop.title}</h1>
          {d.shop.address && <p className="mt-1 text-sm text-zinc-500">{d.shop.address}</p>}
          {d.shop.phone && (
            <a className="mt-1 inline-block text-sm font-medium underline" href={`tel:${d.shop.phone}`}>
              {formatPhone(d.shop.phone) || d.shop.phone}
            </a>
          )}
        </header>

        {(voided || refunded) && (
          <div className={voided ? "bg-zinc-900 px-5 py-3 text-sm text-white" : "bg-amber-50 px-5 py-3 text-sm text-amber-900"} role="status" data-testid="receipt-update">
            <b>Updated receipt.</b>{" "}
            {voided
              ? `This ticket was voided${d.sale.voidedAt ? ` on ${formatDate(d.sale.voidedAt, "MMM d")}` : ""}, and what you paid goes back to how you paid.`
              : `${formatCents(d.refundedCents)} was refunded.`}
          </div>
        )}

        <div className="space-y-5 px-5 py-5">
          <div className="text-sm text-zinc-600">
            {d.firstName && <p className="text-base font-semibold text-zinc-900">Thanks, {d.firstName}!</p>}
            <p>
              Ticket #{d.sale.number} · {formatDateTime(d.sale.paidAt ?? d.sale.createdAt)}
            </p>
            {d.barber && !d.people && <p>Your barber: {d.barber}</p>}
          </div>

          {d.people ? (
            <div className="space-y-4">
              {d.people.map((p, k) => (
                <section key={k} data-testid="receipt-person">
                  <div className="flex items-baseline justify-between border-b border-zinc-100 pb-1 text-sm font-semibold">
                    <span>{personHeading(p)}</span>
                    <span className="tabular">{formatCents(p.cents)}</span>
                  </div>
                  <LineTable lines={p.lines.map((l, j) => ({ id: l.id ?? `${k}-${j}`, name: l.name, qty: l.qty, cents: l.cents, refundedQty: l.refundedQty ?? 0, barber: p.barbers.length > 1 ? l.barber : null }))} />
                </section>
              ))}
            </div>
          ) : (
            <LineTable lines={d.lines} />
          )}

          <table className="w-full border-t border-zinc-100 text-sm tabular">
            <tbody className="[&_td]:py-1">
              {d.discounts.map((x, k) => (
                <tr key={k} className="text-emerald-700">
                  <td>{x.label}</td>
                  <td className="text-right">-{formatCents(x.cents)}</td>
                </tr>
              ))}
              <tr>
                <td>Tax</td>
                <td className="text-right">{formatCents(d.taxCents)}</td>
              </tr>
              <tr>
                <td>Tip</td>
                <td className="text-right">{formatCents(d.tipCents)}</td>
              </tr>
              {d.fee && (
                <tr>
                  <td>{d.fee.label}</td>
                  <td className="text-right">{formatCents(d.fee.cents)}</td>
                </tr>
              )}
              <tr className="text-base font-bold">
                <td className="pt-2">Total</td>
                <td className="pt-2 text-right">{formatCents(d.totalCents)}</td>
              </tr>
              {d.tenders.map((t, k) => (
                <tr key={k} className="text-zinc-600" data-testid="receipt-tender">
                  <td>Paid with {t.label}</td>
                  <td className="text-right">{formatCents(t.cents)}</td>
                </tr>
              ))}
              {d.refunds.map((x, k) => (
                <tr key={k} className="text-red-700">
                  <td>
                    {x.label} · {formatDate(x.at, "MMM d")}
                  </td>
                  <td className="text-right">-{formatCents(x.cents)}</td>
                </tr>
              ))}
              {d.refundedCents > 0 && (
                <tr className="font-semibold" data-testid="receipt-net">
                  <td className="pt-2">You paid, after refunds</td>
                  <td className="pt-2 text-right">{formatCents(d.totalCents - d.refundedCents)}</td>
                </tr>
              )}
            </tbody>
          </table>

          {d.loyalty && (
            <div className="rounded-xl bg-zinc-50 p-4 text-sm ring-1 ring-zinc-200" data-testid="receipt-loyalty">
              <div className="flex items-baseline justify-between">
                <span className="font-semibold">Loyalty</span>
                {d.loyalty.availableCents > 0 && <span className="font-semibold text-emerald-700">{formatCents(d.loyalty.availableCents)} ready to use</span>}
              </div>
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-zinc-200">
                <div className="h-full rounded-full" style={{ width: `${Math.min(100, Math.round((d.loyalty.progressCents / Math.max(1, d.loyalty.thresholdCents)) * 100))}%`, background: accent }} />
              </div>
              <p className="mt-2 text-zinc-600">
                {formatCents(d.loyalty.progressCents)} of {formatCents(d.loyalty.thresholdCents)} toward your next {formatCents(d.loyalty.rewardCents)} reward
              </p>
            </div>
          )}

          {(d.rebookUrl || d.reviewUrl) && (
            <div className="grid gap-2">
              {d.rebookUrl && (
                <Link href={d.rebookUrl} className="flex h-12 items-center justify-center rounded-xl text-base font-semibold text-white" style={{ background: accent }} data-testid="receipt-rebook">
                  Rebook
                </Link>
              )}
              {d.reviewUrl && (
                <a
                  href={`/receipt/${token}/review`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex h-12 items-center justify-center rounded-xl bg-white text-base font-semibold text-zinc-900 ring-1 ring-zinc-300"
                  data-testid="receipt-review"
                >
                  Leave a review
                </a>
              )}
            </div>
          )}

          {d.disclosures.length > 0 && (
            <div className="space-y-1 border-t border-dashed border-zinc-200 pt-3 text-[11px] text-zinc-500">
              {d.disclosures.map((x, k) => (
                <p key={k}>{x}</p>
              ))}
            </div>
          )}
          <p className="text-center text-sm text-zinc-500">{d.shop.footer}</p>
        </div>
      </article>

      <footer className="mt-4 space-y-2 px-2 text-center text-xs text-zinc-500">
        {r.delivery.masked && (
          <p>
            Sent to {r.delivery.masked}.{r.delivery.channel === "sms" && " Reply STOP to the text to stop texts from the shop."}
          </p>
        )}
        {r.delivery.channel === "email" && <StopEmails token={token} stopped={r.emailStopped} />}
        <p>
          <Link className="underline" href="/receipt">
            Get a copy of another receipt
          </Link>
        </p>
      </footer>
    </Shell>
  );
}

function LineTable({ lines }: { lines: { id: string; name: string; qty: number; cents: number; refundedQty: number; barber?: string | null }[] }) {
  return (
    <table className="w-full text-[15px] tabular">
      <tbody>
        {lines.map((l) => (
          <tr key={l.id} className="align-top">
            <td className="py-1.5 pr-3">
              {l.name}
              {l.qty > 1 && <span className="text-zinc-500"> × {l.qty}</span>}
              {l.barber && <span className="text-zinc-500"> · {l.barber}</span>}
              {l.refundedQty > 0 && <span className="block text-xs text-red-700">{l.refundedQty === l.qty ? "Refunded" : `${l.refundedQty} refunded`}</span>}
            </td>
            <td className="py-1.5 text-right">{formatCents(l.cents)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Shell({ accent, children }: { accent: string | null; children: React.ReactNode }) {
  return (
    <div className="min-h-dvh bg-zinc-100" style={{ borderTop: `6px solid ${accent ?? "#111318"}` }}>
      <main className="mx-auto max-w-md px-4 pb-[max(2rem,env(safe-area-inset-bottom))] pt-6">{children}</main>
    </div>
  );
}
