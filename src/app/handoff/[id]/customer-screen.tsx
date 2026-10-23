"use client";

import { useEffect, useState, useTransition } from "react";
import { cx } from "@/components/ui";
import { type HandoffStep, amountsFor, bigTip, screenTipProblem } from "@/domain/handoff";
import type { HandoffView } from "@/server/handoff";
import { StripeCardEntry } from "../../admin/checkout/[saleId]/stripe-card";
import { cardAction, cashAction, finishAction, payAction, readerAction, receiptAction, signAction, tipAction, viewAction } from "./actions";
import { Keypad } from "./keypad";
import { SignaturePad } from "./signature-pad";
import { StaffUnlock } from "./staff-unlock";

type Result<T> = { ok: true; data: T } | { ok: false; error: string };
type Card = { paymentMethodId: string; funding: string; brand: string; last4: string };
type Run = <T>(fn: () => Promise<Result<T>>, ok?: (d: T) => void) => void;

const $ = (c: number) => `${c < 0 ? "-" : ""}$${(Math.abs(c) / 100).toFixed(2)}`;
const LABEL: Record<Exclude<HandoffStep, "done">, string> = { tip: "Tip", signature: "Sign", receipt: "Receipt", pay: "Pay" };
const SHORT_SCREEN = "[@media(max-height:520px)]";

function firstOpen(v: HandoffView): HandoffStep {
  for (const s of v.steps) {
    if (s === "tip" && v.tip.cents == null) return "tip";
    if (s === "signature" && !v.signed) return "signature";
    if (s === "receipt" && !v.receipt.channel) return "receipt";
  }
  return "pay";
}

function finished(v: HandoffView, s: HandoffStep) {
  return (s === "tip" && v.tip.cents != null) || (s === "signature" && v.signed) || (s === "receipt" && !!v.receipt.channel);
}

/**
 * The customer-facing checkout: full screen, nothing of the staff app on it, and the browser's back
 * button kept on this page. Only the small Staff button (a PIN) leaves it before payment.
 */
export function CustomerScreen({ initial }: { initial: HandoffView }) {
  const [v, setV] = useState(initial);
  const [editing, setEditing] = useState<HandoffStep | null>(null);
  const [card, setCard] = useState<Card | null>(null);
  const [items, setItems] = useState(false);
  const [unlocking, setUnlocking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const run: Run = (fn, ok) =>
    start(async () => {
      setError(null);
      const r = await fn();
      if (!r.ok) return setError(r.error);
      ok?.(r.data);
    });
  const show = (next: HandoffView) => {
    setV(next);
    setEditing(null);
  };

  useEffect(() => {
    history.pushState(null, "", location.href);
    const stay = () => history.pushState(null, "", location.href);
    window.addEventListener("popstate", stay);
    return () => window.removeEventListener("popstate", stay);
  }, []);

  // Staff can end the hand-off from another device; notice it here.
  useEffect(() => {
    if (v.status !== "active") return;
    const t = setInterval(async () => {
      const r = await viewAction(v.id);
      if (r.ok && r.data.status !== "active") setV(r.data);
    }, 15_000);
    return () => clearInterval(t);
  }, [v.id, v.status]);

  const step = v.status === "paid" ? "done" : v.status === "returned" ? "returned" : v.cashRequested ? "cash" : (editing ?? firstOpen(v));
  const funding = step === "pay" ? (card?.funding ?? null) : null;

  return (
    <div
      className="fixed inset-0 z-40 flex select-none flex-col overflow-hidden bg-white text-zinc-900 [touch-action:manipulation] landscape:flex-row"
      style={{
        borderTop: `6px solid ${v.shop.accentColor ?? "#111318"}`,
        paddingTop: "env(safe-area-inset-top)",
        paddingBottom: "env(safe-area-inset-bottom)",
        paddingLeft: "env(safe-area-inset-left)",
        paddingRight: "env(safe-area-inset-right)",
      }}
      onContextMenu={(e) => e.preventDefault()}
      data-testid="customer-screen"
    >
      <Summary v={v} funding={funding} open={items} onToggle={() => setItems((x) => !x)} />
      <main className="relative flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pb-6 pt-4 sm:px-8 sm:pt-6 landscape:pt-4">
        <div className="mb-4 flex items-center justify-between gap-3">
          {step !== "done" && step !== "cash" && step !== "returned" ? (
            <Progress v={v} current={step} onPick={(s) => (setError(null), setEditing(s))} disabled={pending} />
          ) : (
            <span />
          )}
          {step !== "returned" && (
            <button
              type="button"
              onClick={() => setUnlocking(true)}
              aria-label="Staff unlock"
              className="flex min-h-11 min-w-11 shrink-0 items-center justify-center gap-1.5 rounded-full px-3 text-sm font-medium text-zinc-400 ring-1 ring-zinc-200 active:bg-zinc-100"
            >
              <LockIcon /> Staff
            </button>
          )}
        </div>
        {error && (
          <div role="alert" className="mb-4 rounded-2xl bg-red-50 px-4 py-3 text-base text-red-800 ring-1 ring-red-200">
            {error}
          </div>
        )}
        <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col">
          {step === "tip" && <TipStep v={v} pending={pending} editing={editing === "tip"} onKeep={() => setEditing(null)} onPick={(choice, cents) => run(() => tipAction(v.id, choice, cents), show)} />}
          {step === "signature" && <SignStep v={v} pending={pending} onSign={(path) => run(() => signAction(v.id, path), show)} />}
          {step === "receipt" && <ReceiptStep v={v} pending={pending} onChoose={(input) => run(() => receiptAction(v.id, input), show)} />}
          {step === "pay" && <PayStep v={v} card={card} setCard={setCard} pending={pending} run={run} show={show} />}
          {step === "cash" && <HandBack title="Please hand the device back to pay cash" detail={v.tipCents > 0 ? `Your ${$(v.tipCents)} tip is saved.` : null} onStaff={() => setUnlocking(true)} />}
          {step === "returned" && <Returned />}
          {step === "done" && <Done v={v} onStaff={() => setUnlocking(true)} />}
        </div>
      </main>
      {unlocking && <StaffUnlock id={v.id} onClose={() => setUnlocking(false)} />}
    </div>
  );
}

function Summary({ v, funding, open, onToggle }: { v: HandoffView; funding: string | null; open: boolean; onToggle: () => void }) {
  const paid = v.status === "paid";
  const fee = (paid || funding === "credit") && v.creditFeeCents > 0;
  const due = amountsFor(v, funding).chargeCents;
  return (
    <aside className="shrink-0 border-b border-zinc-200 bg-zinc-50 px-4 py-3 sm:px-8 sm:py-4 landscape:flex landscape:h-full landscape:w-[38%] landscape:max-w-md landscape:flex-col landscape:overflow-y-auto landscape:border-b-0 landscape:border-r landscape:px-6 landscape:py-6">
      <div className="flex items-center justify-between gap-3 landscape:block">
        <div className="flex min-w-0 items-center gap-3">
          {v.shop.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={v.shop.logoUrl} alt={v.shop.name} className="h-10 max-w-32 object-contain sm:h-12 landscape:h-14 landscape:max-w-48" />
          ) : (
            <div className="truncate text-lg font-semibold tracking-tight sm:text-xl">{v.shop.headline ?? `Ray'z Barber Shop · ${v.shop.name}`}</div>
          )}
        </div>
        <div className="text-right landscape:hidden">
          <div className="text-xs font-medium uppercase tracking-wide text-zinc-500">{paid ? "Paid" : "Total"}</div>
          <div className="text-2xl font-semibold tabular sm:text-3xl" data-testid="due-portrait">
            {$(paid ? v.dueCents : due)}
          </div>
        </div>
      </div>
      <div className="mt-1 flex items-center justify-between gap-2 text-sm text-zinc-500 landscape:mt-4">
        <span className="truncate">
          Ticket #{v.ticketNumber}
          {v.barbers.length > 0 && ` · with ${v.barbers.join(" & ")}`}
        </span>
        <button type="button" onClick={onToggle} className="min-h-11 shrink-0 px-2 font-medium text-zinc-700 underline landscape:hidden" aria-expanded={open}>
          {open ? "Hide items" : `See items (${v.lines.length})`}
        </button>
      </div>
      <dl className={cx("mt-3 max-h-[38dvh] space-y-1.5 overflow-y-auto text-base tabular landscape:block landscape:max-h-none landscape:flex-1", open ? "block" : "hidden")}>
        {v.lines.map((l, i) => (
          <Row key={i} k={l.qty > 1 ? `${l.name} × ${l.qty}` : l.name} v={$(l.cents)} />
        ))}
        {v.discounts.map((d, i) => (
          <Row key={`d${i}`} k={d.label} v={$(-d.cents)} className="text-emerald-700" />
        ))}
        <Row k="Tax" v={$(v.taxCents)} className="text-zinc-600" />
        <Row k="Tip" v={v.tip.cents == null && !paid ? (v.pay.readerTips ? "On the reader" : "—") : $(v.tipCents)} className="text-zinc-600" />
        {v.split.length > 1 && v.tipCents > 0 && <div className="pl-3 text-sm text-zinc-500">Shared: {v.split.map((s) => `${s.label} ${$(s.cents)}`).join(", ")}</div>}
        {fee && v.feeLabel && <Row k={v.feeLabel} v={$(v.creditFeeCents)} className="text-amber-700" />}
        {v.giftCardCents > 0 && <Row k="Gift card" v={$(-v.giftCardCents)} />}
      </dl>
      <div className="mt-4 hidden items-baseline justify-between border-t border-zinc-200 pt-3 landscape:flex">
        <span className="text-lg font-semibold">{paid ? "Paid" : v.giftCardCents > 0 ? "Due now" : "Total"}</span>
        <span className="text-4xl font-semibold tabular" data-testid="due-landscape">
          {$(paid ? v.dueCents : due)}
        </span>
      </div>
      {!paid && !fee && v.feeLabel && v.creditFeeCents > 0 && (
        <p className="mt-2 text-sm text-zinc-500">
          {v.feeLabel}: {$(v.creditFeeCents)} if you pay by credit card ({$(v.creditDueCents)}).
        </p>
      )}
    </aside>
  );
}

function Row({ k, v, className }: { k: string; v: string; className?: string }) {
  return (
    <div className={cx("flex justify-between gap-4", className)}>
      <dt className="min-w-0 truncate">{k}</dt>
      <dd className="shrink-0">{v}</dd>
    </div>
  );
}

function Progress({ v, current, onPick, disabled }: { v: HandoffView; current: HandoffStep; onPick: (s: HandoffStep) => void; disabled: boolean }) {
  const steps = v.steps.filter((s): s is Exclude<HandoffStep, "done"> => s !== "done");
  return (
    <ol className="flex min-w-0 flex-wrap gap-1 text-sm sm:gap-1.5">
      {steps.map((s, i) => {
        const done = finished(v, s);
        const here = s === current;
        return (
          <li key={s}>
            <button
              type="button"
              disabled={disabled || here || !done}
              onClick={() => onPick(s)}
              className={cx(
                "min-h-11 rounded-full px-2.5 font-medium sm:px-3",
                here ? "bg-ink-900 text-white" : done ? "bg-emerald-50 text-emerald-800 ring-1 ring-emerald-200" : "bg-zinc-100 text-zinc-400",
              )}
              aria-current={here ? "step" : undefined}
            >
              {done && !here ? "✓ " : <span className="hidden sm:inline">{i + 1}. </span>}
              {LABEL[s]}
            </button>
          </li>
        );
      })}
    </ol>
  );
}

function Heading({ title, detail }: { title: string; detail?: string | null }) {
  return (
    <div className="mb-5 sm:mb-6">
      <h1 className={cx("text-3xl font-semibold tracking-tight sm:text-4xl", `${SHORT_SCREEN}:text-2xl`)}>{title}</h1>
      {detail && <p className="mt-1 text-base text-zinc-600 sm:text-lg">{detail}</p>}
    </div>
  );
}

const bigBtn = (on: boolean) =>
  cx(
    "flex min-h-24 flex-col items-center justify-center rounded-3xl px-3 py-3 ring-2 transition active:scale-[0.98] disabled:opacity-50",
    `${SHORT_SCREEN}:min-h-16`,
    on ? "bg-ink-900 text-white ring-ink-900" : "bg-white text-zinc-900 ring-zinc-200 active:bg-zinc-50",
  );
const primary = "min-h-16 w-full rounded-3xl bg-ink-900 px-6 text-xl font-semibold text-white transition active:scale-[0.99] disabled:opacity-40";
const quiet = "min-h-14 w-full rounded-3xl px-6 text-lg font-medium text-zinc-700 ring-2 ring-zinc-200 active:bg-zinc-50 disabled:opacity-40";

function TipStep({ v, pending, editing, onKeep, onPick }: { v: HandoffView; pending: boolean; editing: boolean; onKeep: () => void; onPick: (choice: string, cents: number) => void }) {
  const [custom, setCustom] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ choice: string; cents: number } | null>(null);
  const pick = (choice: string, cents: number) => (bigTip(cents, v.servicesCents) ? setConfirm({ choice, cents }) : onPick(choice, cents));
  const n = v.tips.choices.length;
  const who = v.barbers.length ? v.barbers.join(" & ") : null;

  if (confirm) {
    return (
      <div className="flex flex-1 flex-col justify-center">
        <Heading title={`Tip ${$(confirm.cents)}?`} detail={`That's more than half of ${$(v.servicesCents)} in services. Just checking it's right.`} />
        <div className="grid gap-3 sm:grid-cols-2">
          <button type="button" className={quiet} onClick={() => setConfirm(null)}>
            Change it
          </button>
          <button type="button" className={primary} disabled={pending} onClick={() => (onPick(confirm.choice, confirm.cents), setConfirm(null))}>
            Yes, tip {$(confirm.cents)}
          </button>
        </div>
      </div>
    );
  }

  if (custom != null) {
    const cents = Number(custom || "0");
    const problem = cents > 0 ? screenTipProblem(cents) : null;
    return (
      <div className="flex flex-1 flex-col">
        <Heading title="Custom tip" />
        <div className="grid gap-4 landscape:grid-cols-[1fr_minmax(0,320px)] landscape:items-start">
          <div className="space-y-3">
            <div className="rounded-3xl bg-zinc-50 py-4 text-center text-5xl font-semibold tabular ring-2 ring-zinc-200" aria-live="polite" data-testid="custom-tip">
              {$(cents)}
            </div>
            {problem && <p className="text-center text-base text-red-700">{problem}</p>}
            <div className="hidden gap-3 landscape:grid">
              <button type="button" className={primary} disabled={pending || !!problem || cents <= 0} onClick={() => pick("custom", cents)}>
                Add {$(cents)} tip
              </button>
              <button type="button" className={quiet} onClick={() => setCustom(null)}>
                Back
              </button>
            </div>
          </div>
          <Keypad value={custom} onChange={(x) => setCustom(x.replace(/^0+/, ""))} max={5} />
          <div className="grid gap-3 landscape:hidden">
            <button type="button" className={primary} disabled={pending || !!problem || cents <= 0} onClick={() => pick("custom", cents)}>
              Add {$(cents)} tip
            </button>
            <button type="button" className={quiet} onClick={() => setCustom(null)}>
              Back
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col">
      <Heading title="Add a tip?" detail={who ? `Your tip goes to ${who}.` : null} />
      <div className={cx("grid gap-3 sm:gap-4", n >= 4 ? "grid-cols-2 lg:grid-cols-4" : n === 3 ? "grid-cols-3" : n === 2 ? "grid-cols-2" : "grid-cols-1")}>
        {v.tips.choices.map((c) => (
          <button key={c.key} type="button" disabled={pending} onClick={() => pick(c.key, c.cents)} className={bigBtn(v.tip.choice === c.key)} data-testid={`tip-${c.key}`}>
            <span className={cx("text-3xl font-semibold sm:text-4xl", `${SHORT_SCREEN}:text-2xl`)}>{c.label}</span>
            {c.detail && <span className="mt-1 text-base tabular opacity-70">{c.detail}</span>}
          </button>
        ))}
      </div>
      <div className={cx("mt-3 grid gap-3 sm:mt-4 sm:gap-4", v.tips.allowCustom && v.tips.allowNoTip ? "grid-cols-2" : "grid-cols-1")}>
        {v.tips.allowCustom && (
          <button type="button" disabled={pending} onClick={() => setCustom("")} className={bigBtn(v.tip.choice === "custom")}>
            <span className="text-xl font-semibold">Custom tip</span>
            {v.tip.choice === "custom" && <span className="mt-1 text-base tabular opacity-70">{$(v.tipCents)}</span>}
          </button>
        )}
        {v.tips.allowNoTip && (
          <button type="button" disabled={pending} onClick={() => pick("none", 0)} className={bigBtn(v.tip.choice === "none")} data-testid="tip-none">
            <span className="text-xl font-semibold">No tip</span>
          </button>
        )}
      </div>
      {editing && (
        <button type="button" className={cx(quiet, "mt-4")} onClick={onKeep}>
          Keep {$(v.tipCents)}
        </button>
      )}
      {v.feeNotice && <p className="mt-auto pt-6 text-sm text-zinc-500">{v.feeNotice}</p>}
    </div>
  );
}

function SignStep({ v, pending, onSign }: { v: HandoffView; pending: boolean; onSign: (path: string) => void }) {
  const [path, setPath] = useState("");
  const amount = v.pay.readerTips && v.tip.cents == null ? `${$(v.dueCents)} plus any tip I add on the reader` : $(v.dueCents);
  return (
    <div className="flex flex-1 flex-col">
      <Heading title="Sign here" detail={`I agree to pay ${amount}${v.feeLabel && v.creditFeeCents > 0 ? `, or ${$(v.creditDueCents)} with a credit card` : ""}.`} />
      <SignaturePad onChange={setPath} />
      <button type="button" className={cx(primary, "mt-4")} disabled={pending || path.split("L").length < 4} onClick={() => onSign(path)}>
        Done signing
      </button>
    </div>
  );
}

const fmtPhone = (d: string) => (d.length <= 3 ? d : d.length <= 6 ? `(${d.slice(0, 3)}) ${d.slice(3)}` : `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`);

function ReceiptStep({ v, pending, onChoose }: { v: HandoffView; pending: boolean; onChoose: (input: { channel: "sms" | "email" | "none"; onFile: boolean; to?: string }) => void }) {
  const [mode, setMode] = useState<"sms" | "email" | null>(null);
  const [typing, setTyping] = useState(false);
  const [to, setTo] = useState("");
  const onFile = mode === "sms" ? v.receipt.onFile.phone : mode === "email" ? v.receipt.onFile.email : null;

  if (mode) {
    const enter = typing || !onFile;
    return (
      <div className="flex flex-1 flex-col">
        <Heading
          title={mode === "sms" ? "Text my receipt" : "Email my receipt"}
          detail={mode === "sms" ? (enter ? "We'll text you a link to your receipt." : "We'll text a link to the number on file.") : enter ? "We'll email you your receipt." : "We'll email it to the address on file."}
        />
        {!enter ? (
          <div className="grid gap-3">
            <button type="button" className={primary} disabled={pending} onClick={() => onChoose({ channel: mode, onFile: true })}>
              Send to {onFile}
            </button>
            <button type="button" className={quiet} onClick={() => setTyping(true)}>
              {mode === "sms" ? "Use a different number" : "Use a different email"}
            </button>
          </div>
        ) : mode === "sms" ? (
          <div className="grid gap-4 landscape:grid-cols-[1fr_minmax(0,320px)] landscape:items-start">
            <div className="space-y-3">
              <div className="min-h-16 rounded-3xl bg-zinc-50 px-4 py-4 text-center text-3xl font-semibold tabular ring-2 ring-zinc-200" aria-live="polite">
                {to ? fmtPhone(to) : <span className="text-zinc-400">Mobile number</span>}
              </div>
              <button type="button" className={primary} disabled={pending || to.length !== 10} onClick={() => onChoose({ channel: "sms", onFile: false, to })}>
                Text my receipt
              </button>
            </div>
            <Keypad value={to} onChange={setTo} max={10} />
          </div>
        ) : (
          <form
            className="grid gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              onChoose({ channel: "email", onFile: false, to });
            }}
          >
            <input
              type="email"
              inputMode="email"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="name@example.com"
              value={to}
              onChange={(e) => setTo(e.target.value.trim())}
              className="min-h-16 w-full select-text rounded-3xl px-5 text-2xl ring-2 ring-zinc-200 focus:outline-none focus:ring-ink-900"
              aria-label="Email address"
            />
            <button className={primary} disabled={pending || !to.includes("@")}>
              Email my receipt
            </button>
          </form>
        )}
        <button
          type="button"
          className="mt-4 min-h-12 self-start px-2 text-base font-medium text-zinc-600 underline"
          onClick={() => {
            setMode(null);
            setTyping(false);
            setTo("");
          }}
        >
          Back
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col">
      <Heading title="How would you like your receipt?" detail="A text with a link, or an email. No paper." />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 sm:gap-4">
        <button type="button" disabled={pending} className={bigBtn(v.receipt.channel === "sms")} onClick={() => setMode("sms")}>
          <span className="text-2xl font-semibold">Text</span>
          {v.receipt.onFile.phone && <span className="mt-1 text-sm opacity-70">{v.receipt.onFile.phone}</span>}
        </button>
        <button type="button" disabled={pending} className={bigBtn(v.receipt.channel === "email")} onClick={() => setMode("email")}>
          <span className="text-2xl font-semibold">Email</span>
          {v.receipt.onFile.email && <span className="mt-1 truncate text-sm opacity-70">{v.receipt.onFile.email}</span>}
        </button>
        <button type="button" disabled={pending} className={bigBtn(v.receipt.channel === "none")} onClick={() => onChoose({ channel: "none", onFile: false })} data-testid="receipt-none">
          <span className="text-2xl font-semibold">No receipt</span>
        </button>
      </div>
    </div>
  );
}

function PayStep({ v, card, setCard, pending, run, show }: { v: HandoffView; card: Card | null; setCard: (c: Card | null) => void; pending: boolean; run: Run; show: (v: HandoffView) => void }) {
  const hasReader = v.pay.readers.length > 0;
  const [via, setVia] = useState<"reader" | "keyed">(hasReader ? "reader" : "keyed");
  const [readerId, setReaderId] = useState(v.pay.readers[0]?.id ?? "");
  const [readerTip, setReaderTip] = useState<{ choice: string; cents: number } | null>(null);
  const { chargeCents, totalCents } = amountsFor(v, card?.funding ?? null);
  const askTipHere = via === "keyed" && v.pay.readerTips && v.tip.cents == null;
  const askTipOnReader = via === "reader" && v.pay.readerTips && v.tip.source !== "reader" && !readerTip;
  const got = (d: { card: Card; view: HandoffView }) => {
    setCard(d.card);
    show(d.view);
  };
  const pay = (tender: Parameters<typeof payAction>[1], expected: number) =>
    run(
      () => payAction(v.id, tender, expected),
      () => run(() => viewAction(v.id), show),
    );
  const cash = (
    <button type="button" className={cx(quiet, "mt-4")} disabled={pending} onClick={() => run(() => cashAction(v.id), show)}>
      Pay with cash instead
    </button>
  );

  if (v.dueCents === 0 && v.tip.cents != null) {
    return (
      <div className="flex flex-1 flex-col">
        <Heading title="You're all set" detail={v.giftCardCents > 0 ? "Your gift card covers today's total." : "Nothing is due today."} />
        <button type="button" className={primary} disabled={pending} onClick={() => pay({ method: "none" }, v.totalCents)}>
          Complete
        </button>
      </div>
    );
  }

  if (!v.pay.cards) {
    return (
      <div className="flex flex-1 flex-col">
        <Heading title={`Pay ${$(v.dueCents)}`} detail="Cards aren't available here right now. Hand the device back to pay cash." />
        {cash}
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col">
      <Heading
        title={`Pay ${$(chargeCents)}`}
        detail={card ? null : v.feeLabel && v.creditFeeCents > 0 ? `Debit ${$(v.dueCents)} · credit ${$(v.creditDueCents)}` : v.pay.readerTips && v.tip.cents == null ? "Plus any tip you add" : null}
      />
      {card ? (
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-3 rounded-3xl bg-zinc-50 px-5 py-4 ring-2 ring-zinc-200">
            <div className="text-xl">
              <span className="font-semibold capitalize">{card.brand}</span> •••• {card.last4}
              <span className="ml-2 rounded-full bg-zinc-200 px-2 py-0.5 text-sm capitalize">{card.funding}</span>
            </div>
            <button type="button" className="min-h-12 px-2 text-base font-medium underline" onClick={() => setCard(null)}>
              Change
            </button>
          </div>
          {card.funding === "credit" && v.creditFeeCents > 0 && v.feeLabel && (
            <p className="text-base text-amber-800">
              Includes a {$(v.creditFeeCents)} {v.feeLabel.toLowerCase()}.
            </p>
          )}
          <button
            type="button"
            className={primary}
            disabled={pending}
            data-testid="pay"
            onClick={() => pay({ method: "card", paymentMethodId: card.paymentMethodId, entryMode: via === "reader" ? "terminal" : "keyed", readerId: via === "reader" ? readerId : null }, totalCents)}
          >
            {pending ? "Paying…" : `Pay ${$(chargeCents)}`}
          </button>
        </div>
      ) : (
        <>
          {hasReader && (
            <div className="mb-4 grid grid-cols-2 gap-2 rounded-3xl bg-zinc-100 p-1.5">
              {(["reader", "keyed"] as const).map((m) => (
                <button key={m} type="button" onClick={() => (setVia(m), setReaderTip(null))} className={cx("min-h-14 rounded-2xl text-lg font-medium", via === m ? "bg-white shadow-sm" : "text-zinc-600")}>
                  {m === "reader" ? "Tap or insert" : "Type a card"}
                </button>
              ))}
            </div>
          )}
          {askTipHere ? (
            <TipStep v={v} pending={pending} editing={false} onKeep={() => {}} onPick={(choice, cents) => run(() => tipAction(v.id, choice, cents), show)} />
          ) : via === "reader" ? (
            <div className="rounded-3xl bg-ink-900 p-4 text-white sm:p-5">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-sm text-zinc-400">
                <span>{v.pay.readerLabel}</span>
                {v.pay.readers.length > 1 && (
                  <select className="min-h-11 rounded-xl bg-white/10 px-3 text-base text-white" value={readerId} onChange={(e) => setReaderId(e.target.value)} aria-label="Reader">
                    {v.pay.readers.map((r) => (
                      <option key={r.id} value={r.id} className="text-zinc-900">
                        {r.label}
                      </option>
                    ))}
                  </select>
                )}
              </div>
              {askTipOnReader ? (
                <>
                  <div className="mb-3 text-xl font-semibold">Add a tip on the reader?</div>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    {v.tips.choices.slice(0, 3).map((c) => (
                      <button key={c.key} type="button" onClick={() => setReaderTip({ choice: c.key, cents: c.cents })} className="min-h-16 rounded-2xl bg-white/10 text-lg font-semibold active:bg-white/20">
                        {c.label}
                        {c.detail && <span className="block text-sm font-normal text-zinc-400">{c.detail}</span>}
                      </button>
                    ))}
                    <button type="button" onClick={() => setReaderTip({ choice: "none", cents: 0 })} className="min-h-16 rounded-2xl bg-white/10 text-lg font-semibold active:bg-white/20">
                      No tip
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div className="mb-3 text-xl font-semibold">
                    {readerTip ? `Tip ${$(readerTip.cents)} · ` : ""}Tap, insert or swipe your card
                  </div>
                  <p className="mb-3 text-sm text-zinc-400">Test mode: tap a test card to present it.</p>
                  <div className="grid grid-cols-2 gap-2">
                    {v.pay.testCards.map((tc) => (
                      <button
                        key={tc.id}
                        type="button"
                        disabled={pending}
                        onClick={() => run(() => readerAction(v.id, { testCard: tc.id, readerId, tip: v.pay.readerTips ? readerTip : null }), got)}
                        className="min-h-14 rounded-2xl bg-white/10 px-3 text-left text-base active:bg-white/20"
                      >
                        {tc.label}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          ) : v.pay.publishableKey ? (
            <div className="rounded-3xl p-4 ring-2 ring-zinc-200">
              <StripeCardEntry publishableKey={v.pay.publishableKey} amountCents={v.dueCents} onPaymentMethod={(pm) => run(() => cardAction(v.id, pm), got)} />
            </div>
          ) : (
            <div>
              <p className="mb-3 text-base text-zinc-600">Payment simulator: pick a Stripe test card.</p>
              <div className="grid grid-cols-2 gap-2">
                {v.pay.testCards.map((tc) => (
                  <button key={tc.id} type="button" disabled={pending} onClick={() => run(() => cardAction(v.id, tc.id), got)} className="min-h-14 rounded-2xl px-3 text-left text-base ring-2 ring-zinc-200 active:bg-zinc-50">
                    {tc.label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </>
      )}
      {v.feeNotice && <p className="mt-4 text-sm text-zinc-500">{v.feeNotice}</p>}
      {cash}
    </div>
  );
}

function HandBack({ title, detail, onStaff }: { title: string; detail: string | null; onStaff: () => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
      <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">{title}</h1>
      {detail && <p className="text-lg text-zinc-600">{detail}</p>}
      <button type="button" className={cx(quiet, "max-w-sm")} onClick={onStaff}>
        Staff: unlock
      </button>
    </div>
  );
}

function Returned() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
      <h1 className="text-3xl font-semibold tracking-tight">Staff took this ticket back</h1>
      <p className="text-lg text-zinc-600">Please hand the device back.</p>
      <button type="button" className={cx(quiet, "max-w-sm")} onClick={() => window.location.replace("/admin")}>
        Staff screens
      </button>
    </div>
  );
}

function Done({ v, onStaff }: { v: HandoffView; onStaff: () => void }) {
  const ends = v.returnsAt ? new Date(v.returnsAt).getTime() : null;
  const [now, setNow] = useState(() => Date.now());
  const [error, setError] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  const left = ends ? Math.max(0, Math.ceil((ends - now) / 1000)) : null;
  const leave = async () => {
    if (leaving) return;
    setLeaving(true);
    const r = await finishAction(v.id);
    if (!r.ok) {
      setLeaving(false);
      return setError(r.error);
    }
    window.location.replace(r.data.path);
  };

  useEffect(() => {
    if (!ends) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [ends]);
  useEffect(() => {
    if (left === 0 && !error) void leave();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [left, error]);

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center" data-testid="thank-you">
      <div className="flex h-20 w-20 items-center justify-center rounded-full bg-emerald-100 text-4xl text-emerald-700">✓</div>
      <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">Thank you!</h1>
      <p className="text-2xl text-zinc-700">Please hand the device back{v.barbers.length ? ` to ${v.barbers[0]}` : ""}.</p>
      {v.receipt.channel && v.receipt.channel !== "none" && v.receipt.masked && (
        <p className="text-base text-zinc-500">
          Your receipt is on its way to {v.receipt.masked}.
        </p>
      )}
      {error && <p className="text-base text-red-700">{error}</p>}
      {left != null ? (
        <button type="button" className={cx(quiet, "max-w-sm")} onClick={leave} disabled={leaving}>
          {leaving ? "Returning…" : `Done (returning in ${left}s)`}
        </button>
      ) : (
        <button type="button" className={cx(quiet, "max-w-sm")} onClick={onStaff}>
          Staff: unlock
        </button>
      )}
    </div>
  );
}

function LockIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}
