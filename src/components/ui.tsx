import clsx from "clsx";
import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";

export const cx = clsx;

type Variant = "primary" | "secondary" | "ghost" | "danger" | "dark";
const variants: Record<Variant, string> = {
  primary: "bg-brand-600 text-white hover:bg-brand-700 shadow-sm",
  secondary: "bg-white text-zinc-900 ring-1 ring-inset ring-zinc-300 hover:bg-zinc-50",
  ghost: "text-zinc-700 hover:bg-zinc-100",
  danger: "bg-white text-red-700 ring-1 ring-inset ring-red-300 hover:bg-red-50",
  dark: "bg-ink-900 text-white hover:bg-ink-700",
};
const sizes = { sm: "h-8 px-3 text-sm", md: "h-10 px-4 text-sm", lg: "h-12 px-5 text-base" };

export function buttonClass(variant: Variant = "primary", size: keyof typeof sizes = "md", extra?: string) {
  return cx(
    "inline-flex items-center justify-center gap-2 rounded-lg font-medium transition disabled:opacity-50 disabled:pointer-events-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600",
    variants[variant],
    sizes[size],
    extra,
  );
}

export function Button({ variant = "primary", size = "md", className, ...props }: ComponentProps<"button"> & { variant?: Variant; size?: keyof typeof sizes }) {
  return <button className={buttonClass(variant, size, className)} {...props} />;
}

export function LinkButton({ variant = "primary", size = "md", className, ...props }: ComponentProps<typeof Link> & { variant?: Variant; size?: keyof typeof sizes }) {
  return <Link className={buttonClass(variant, size, className)} {...props} />;
}

export function Card({ className, ...props }: ComponentProps<"div">) {
  return <div className={cx("rounded-xl bg-white ring-1 ring-zinc-200 shadow-xs", className)} {...props} />;
}

export function CardHeader({ title, action, subtitle }: { title: ReactNode; action?: ReactNode; subtitle?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-zinc-100 px-4 py-3">
      <div>
        <h2 className="text-sm font-semibold text-zinc-900">{title}</h2>
        {subtitle && <p className="mt-0.5 text-xs text-zinc-500">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

const tones = {
  gray: "bg-zinc-100 text-zinc-700",
  green: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  blue: "bg-sky-50 text-sky-700 ring-sky-200",
  amber: "bg-amber-50 text-amber-800 ring-amber-200",
  red: "bg-red-50 text-red-700 ring-red-200",
  violet: "bg-violet-50 text-violet-700 ring-violet-200",
};
export function Badge({ tone = "gray", children, className }: { tone?: keyof typeof tones; children: ReactNode; className?: string }) {
  return <span className={cx("inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ring-transparent", tones[tone], className)}>{children}</span>;
}

const STAR_TONE = { red: "bg-red-50 text-red-700 ring-red-200", amber: "bg-amber-50 text-amber-800 ring-amber-200", green: "bg-emerald-50 text-emerald-700 ring-emerald-200" };

/** Staff-only star badge: the client's average rating. Renders nothing for an unrated client. */
export function StarBadge({ rating, showCount = true, className }: { rating: { avg: number; count: number } | null | undefined; showCount?: boolean; className?: string }) {
  if (!rating || rating.count === 0) return null;
  const avg = (Math.round(rating.avg * 10) / 10).toFixed(1);
  const tone = rating.avg < 3 ? "red" : rating.avg < 4 ? "amber" : "green";
  return (
    <span
      title={`${avg} average from ${rating.count} staff rating${rating.count === 1 ? "" : "s"}`}
      aria-label={`Rated ${avg} out of 5 by staff`}
      className={cx("inline-flex shrink-0 items-center gap-0.5 rounded-full px-1.5 py-px text-[11px] font-semibold tabular ring-1 ring-inset", STAR_TONE[tone], className)}
    >
      ★ {avg}
      {showCount && <span className="font-normal">({rating.count})</span>}
    </span>
  );
}

export const STATUS_TONE: Record<string, keyof typeof tones> = {
  booked: "blue",
  confirmed: "blue",
  checked_in: "amber",
  in_service: "violet",
  completed: "green",
  cancelled: "gray",
  no_show: "red",
  paid: "green",
  open: "amber",
  voided: "gray",
  refunded: "red",
  partially_refunded: "amber",
  pending: "amber",
  sent: "green",
  suppressed: "gray",
  failed: "red",
};
export const STATUS_LABEL: Record<string, string> = {
  booked: "Booked",
  confirmed: "Confirmed",
  checked_in: "Checked in",
  in_service: "In chair",
  completed: "Completed",
  cancelled: "Cancelled",
  no_show: "No-show",
};
export function StatusBadge({ status }: { status: string }) {
  return <Badge tone={STATUS_TONE[status] ?? "gray"}>{STATUS_LABEL[status] ?? status.replace(/_/g, " ")}</Badge>;
}

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: "up" | "down" }) {
  return (
    <Card className="p-4">
      <div className="text-xs font-medium uppercase tracking-wide text-zinc-500">{label}</div>
      <div className="tabular mt-1 text-2xl font-semibold text-zinc-900">{value}</div>
      {hint && <div className={cx("mt-1 text-xs", tone === "down" ? "text-red-600" : tone === "up" ? "text-emerald-600" : "text-zinc-500")}>{hint}</div>}
    </Card>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-zinc-900 sm:text-2xl">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-zinc-500">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-zinc-300 bg-white px-6 py-10 text-center">
      <div className="text-sm font-medium text-zinc-900">{title}</div>
      {children && <div className="mt-1 text-sm text-zinc-500">{children}</div>}
    </div>
  );
}

export const inputClass =
  "block rounded-lg border-0 bg-white px-3 py-2 text-sm text-zinc-900 ring-1 ring-inset ring-zinc-300 placeholder:text-zinc-400 focus:ring-2 focus:ring-inset focus:ring-brand-600 disabled:cursor-not-allowed disabled:bg-zinc-50 disabled:text-zinc-500";

/** Full width unless the caller sizes it (classes don't merge, so `w-full` would win). */
const fieldClass = (extra?: string) => cx(inputClass, !/(^|\s)w-/.test(extra ?? "") && "w-full", extra);

export function Input(props: ComponentProps<"input">) {
  return <input {...props} className={fieldClass(props.className)} />;
}
export function Select(props: ComponentProps<"select">) {
  return <select {...props} className={cx(fieldClass(props.className), "pr-8")} />;
}
export function Textarea(props: ComponentProps<"textarea">) {
  return <textarea {...props} className={fieldClass(props.className)} />;
}
export function Field({ label, hint, children, className }: { label: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={cx("block", className)}>
      <span className="mb-1 block text-xs font-medium text-zinc-700">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-zinc-500">{hint}</span>}
    </label>
  );
}

/** `label` names a table that scrolls on its own, and lets the keyboard focus and scroll it. */
export function Table({ children, className, label }: { children: ReactNode; className?: string; label?: string }) {
  return (
    <div className={cx("relative overflow-x-auto", className)} {...(label ? { role: "region", "aria-label": label, tabIndex: 0 } : {})}>
      <table className="min-w-full text-sm">{children}</table>
    </div>
  );
}
export function Th({ children, className, right }: { children?: ReactNode; className?: string; right?: boolean }) {
  return <th className={cx("whitespace-nowrap border-b border-zinc-200 bg-zinc-50 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-zinc-500", right ? "text-right" : "text-left", className)}>{children}</th>;
}
export function Td({ children, className, right }: { children?: ReactNode; className?: string; right?: boolean }) {
  return <td className={cx("whitespace-nowrap border-b border-zinc-100 px-3 py-2", right && "tabular text-right", className)}>{children}</td>;
}

export function Notice({ tone = "amber", children }: { tone?: "amber" | "blue" | "red" | "green"; children: ReactNode }) {
  const c = { amber: "bg-amber-50 text-amber-900 ring-amber-200", blue: "bg-sky-50 text-sky-900 ring-sky-200", red: "bg-red-50 text-red-900 ring-red-200", green: "bg-emerald-50 text-emerald-900 ring-emerald-200" }[tone];
  return <div className={cx("rounded-lg px-3 py-2 text-sm ring-1 ring-inset", c)}>{children}</div>;
}

/** A brand-controlled setting a shop manager can see but not change (Setup → Sync status → Shop edits). */
export function BrandLock({ what, plural, className }: { what: string; plural?: boolean; className?: string }) {
  return (
    <span className={cx("inline-flex items-center gap-1.5 rounded-md bg-zinc-100 px-2 py-1 text-xs text-zinc-600", className)} data-testid="brand-lock">
      <svg viewBox="0 0 16 16" className="h-3 w-3 shrink-0" fill="currentColor" aria-hidden>
        <path d="M5 7V5a3 3 0 1 1 6 0v2h.5A1.5 1.5 0 0 1 13 8.5v5a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 3 13.5v-5A1.5 1.5 0 0 1 4.5 7H5Zm1.5 0h3V5a1.5 1.5 0 0 0-3 0v2Z" />
      </svg>
      {what} {plural ? "are" : "is"} set by the brand. A brand admin can let shops change {plural ? "them" : "it"} under Setup → Sync status.
    </span>
  );
}

export function Logo({ dark }: { dark?: boolean }) {
  return (
    <span className={cx("inline-flex items-center gap-2 font-semibold tracking-tight", dark ? "text-white" : "text-zinc-900")}>
      <span className="grid h-7 w-7 place-items-center rounded-md bg-brand-600 text-xs font-black text-white">RZ</span>
      <span>Ray&apos;z Barber Shop</span>
    </span>
  );
}

/** Suggestions for an <Input list={id}>; staff can still type anything. */
export function Suggestions({ id, items }: { id: string; items: readonly string[] }) {
  return (
    <datalist id={id}>
      {items.map((x) => (
        <option key={x} value={x} />
      ))}
    </datalist>
  );
}
