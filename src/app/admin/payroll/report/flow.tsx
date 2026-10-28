import { Card, CardHeader, Notice } from "@/components/ui";
import { fmtMoney } from "@/domain/payroll/calc";
import { formatDateTime } from "@/lib/time";
import type { ApprovalStatus, ApprovalView, PayrollView, payrollTrail } from "@/server/payroll/run";

/** Where the period is in run → review → approve → lock. */
export function ApprovalNotice({ view, approval, status, preparers = [] }: { view: PayrollView; approval: ApprovalView | null; status: ApprovalStatus; preparers?: readonly { label: string }[] }) {
  const prepared = preparers.length ? ` Figures changed by hand by ${preparers.map((p) => p.label).join(", ")}; someone else approves them, or the Brand Owner.` : "";
  const lockedAt = view.blocks.find((b) => b.locked)?.locked;
  if (status === "locked")
    return (
      <Notice tone="green">
        Approved{approval ? ` ${formatDateTime(approval.approvedAt)}${approval.approvedBy ? ` by ${approval.approvedBy}` : ""}` : ""} and locked
        {lockedAt ? ` ${formatDateTime(lockedAt.at)}${lockedAt.by ? ` by ${lockedAt.by}` : ""}` : ""}. The figures and each shop&apos;s iSolved file are exactly what was approved.
      </Notice>
    );
  if (status === "approved" && approval)
    return (
      <Notice tone="blue">
        Approved {formatDateTime(approval.approvedAt)}
        {approval.approvedBy && ` by ${approval.approvedBy}`}
        {approval.note && ` (${approval.note})`}: Service Sales {fmtMoney(approval.totals.service)}, Total Wages {fmtMoney(approval.totals.employeeCost)} (the workbook&apos;s Employee Cost, before O.T. and training pay). The iSolved files download now. Lock the
        period to finish; any change before then needs approving again.
      </Notice>
    );
  if (status === "stale" && approval)
    return (
      <Notice tone="amber">
        The figures changed since {approval.approvedBy ?? "someone"} approved them {formatDateTime(approval.approvedAt)}, so the approval no longer covers them and the iSolved files are held.
        Review the changes, then approve again (or take the approval back).{prepared}
      </Notice>
    );
  return (
    <Notice tone="amber">
      Draft: review every shop, then approve the figures. The iSolved files download once they&apos;re approved.{prepared}
    </Notice>
  );
}

type Trail = Awaited<ReturnType<typeof payrollTrail>>;

const str = (v: unknown) => (typeof v === "string" ? v : v === null || v === undefined ? "" : String(v));

function describe(r: Trail[number], names: Map<string, string>): string {
  const d = r.details;
  const who = r.entityId ? (names.get(r.entityId) ?? "an employee") : "";
  switch (r.action) {
    case "payroll.approve":
      return `Approved the figures: Service Sales ${fmtMoney(Number(d.service ?? 0))}, Employee Cost ${fmtMoney(Number(d.employeeCost ?? 0))}${d.anomalies ? `, ${str(d.anomalies)} anomal${d.anomalies === 1 ? "y" : "ies"} reviewed` : ""}${d.note ? ` (${str(d.note)})` : ""}${d.selfApproved ? ", including their own changes (Brand Owner)" : ""}`;
    case "payroll.approval_revoked":
      return `Took back the approval: ${str(d.reason)}`;
    case "payroll.lock":
      return `Locked ${str(d.payGroup)}: ${str(d.rows)} rows`;
    case "payroll.download":
      return `Downloaded ${str(d.file)}${d.locked ? "" : " (approved, before the lock)"}`;
    case "payroll.isolved_file":
      return `Downloaded the all-shops iSolved workbook${d.status ? ` (${str(d.status)})` : ""}`;
    case "payroll.report_file":
      return `Downloaded the Payroll Report (${str(d.format)})`;
    case "payroll.override":
      return `Adjusted ${who}'s ${str(d.field)} to ${str(d.value)}: ${str(d.reason)}`;
    case "payroll.override_clear":
      return `Removed the adjustment to ${who}'s ${str(d.field)}`;
    case "payroll.late_commission":
      return `Added late commission for ${who}: ${fmtMoney(Number(d.amountCents ?? 0) / 100)}${d.reason ? ` (${str(d.reason)})` : ""}`;
    case "payroll.isolved_sent":
      return "Marked the iSolved file sent";
    case "payroll.isolved_unsent":
      return `Took off the sent mark: ${str(d.reason)}`;
    default:
      return r.action.replace(/^payroll\./, "").replace(/_/g, " ");
  }
}

/** Every recorded step for the period, oldest first. */
export function PayrollTrailCard({ trail, names }: { trail: Trail; names: Map<string, string> }) {
  return (
    <Card>
      <CardHeader title="Audit trail" subtitle="Adjustments, approvals, take-backs, locks and downloads for this pay period, oldest first." />
      {trail.length ? (
        <ul className="divide-y divide-zinc-100 text-sm" data-testid="payroll-trail">
          {trail.map((r, i) => (
            <li key={i} className="flex flex-wrap gap-x-3 px-4 py-1.5">
              <span className="w-40 shrink-0 tabular-nums text-zinc-500">{formatDateTime(r.at)}</span>
              <span className="w-36 shrink-0 text-zinc-600">{r.by ?? "System"}</span>
              <span>{describe(r, names)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-4 py-3 text-sm text-zinc-500">Nothing recorded for this pay period yet.</p>
      )}
    </Card>
  );
}
