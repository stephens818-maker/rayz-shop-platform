import { and, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { notificationJobs, savedReportSends, savedReports, staff } from "@/db/schema";
import { ReportDefinition, ReportSchedule, cellText, duePeriod, totalHeader, totalType, type ExportFormat, type ReportResult } from "@/domain/report-builder";
import { appBaseUrl } from "@/lib/deployment";
import { RANGE_TIME_ZONE } from "@/domain/report-range";
import { formatDateTime, localMinutesOf, todayLocal, type LocalDate } from "@/lib/time";
import { audit } from "../audit";
import type { StaffContext } from "../auth/staff";
import { clientPolicy, recordClientAccess } from "../client-privacy";
import { forbidden } from "../errors";
import { processDueJobs } from "../notifications/queue";
import { staffContextFor } from "./context";
import { runReport, type RunResult } from "./engine";
import { renderReport, type ExportFile } from "./export";
import { exportDenied, mayOpen } from "./saved";

type Row = typeof savedReports.$inferSelect;

/** A claim this old that never got queued belongs to a run that died; the next run may take it. */
const STALE_CLAIM_MS = 10 * 60_000;

/**
 * The whole report as a file, as this person may see it, logged in the client data access log and
 * the audit log with the clients and fields it held.
 */
export async function exportReport(
  ctx: StaffContext,
  r: { id: string | null; name: string; definition: ReportDefinition; own: boolean },
  format: ExportFormat,
  o: { now?: Date; scheduled?: boolean } = {},
): Promise<{ file: ExportFile; result: RunResult }> {
  const denied = exportDenied(ctx, r.definition.source);
  if (denied) throw forbidden(denied);
  const now = o.now ?? new Date();
  const policy = await clientPolicy(ctx);
  const result = await runReport(ctx, policy, r.definition, { all: true, own: r.own, now });
  const file = await renderReport(result, format, {
    name: r.name,
    subtitle: `${result.rangeLabel} · ${result.scopeLabel}${result.truncated ? ` · first ${result.lines.filter((l) => l.kind === "row").length.toLocaleString("en-US")} of ${result.total.toLocaleString("en-US")}` : ""}`,
    generated: `Generated ${formatDateTime(now)}`,
    date: todayLocal(now),
    summary: r.definition.summary,
  });
  const fields = result.columns.map((c) => `${c.key}${c.masked ? ":masked" : ""}`);
  const detail = { export: "custom_report", report: r.id, name: r.name, format, clients: result.customerIds.length, fields, ...(o.scheduled ? { scheduled: true } : {}) };
  await recordClientAccess(ctx, { kind: "export", detail });
  await audit(ctx.actor, "report_builder.export", "saved_report", r.id, { ...detail, customerIds: result.customerIds }, ctx.currentShopId);
  return { file, result };
}

/** The report's totals in words, for the email body and the Morning Dashboard: never a client's row. */
export function totalsSummary(result: Pick<ReportResult, "columns" | "totals" | "total" | "noun">, summary: boolean): string[] {
  const out = [`${result.total.toLocaleString("en-US")} ${summary ? "group" : (result.noun ?? "client")}${result.total === 1 ? "" : "s"}`];
  if (result.totals) result.columns.forEach((c, i) => c.agg !== "none" && out.push(`${totalHeader(c)}: ${cellText(totalType(c), result.totals!.cells[i]) || "—"}`));
  return out;
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

function email(r: Row, firstName: string, result: RunResult, file: ExportFile | null, why: string | null) {
  const link = `${appBaseUrl()}/admin/reports/custom/${r.id}`;
  const lines = totalsSummary(result, ReportDefinition.parse(r.definition).summary);
  const attached = file ? `The ${file.filename.split(".").pop()!.toUpperCase()} is attached.` : why ? `No file is attached: ${why.charAt(0).toLowerCase()}${why.slice(1)}.` : "";
  const subject = `${r.name} · ${result.rangeLabel}: ${lines[0]}`;
  const body = [`Hi ${firstName},`, "", `${r.name}`, `${result.rangeLabel} · ${result.scopeLabel} · dates in ${RANGE_TIME_ZONE}`, "", ...lines.map((l) => `- ${l}`), "", attached, `Open it: ${link}`, "", "Change or stop this email in the report's schedule."].filter((l, i, a) => l !== "" || a[i - 1] !== "").join("\n");
  const html = `<div style="font-family:system-ui,sans-serif;font-size:14px;color:#18181b;max-width:560px">
<p>Hi ${escapeHtml(firstName)},</p>
<h2 style="font-size:18px;margin:16px 0 4px">${escapeHtml(r.name)}</h2>
<p style="color:#71717a;margin:0 0 12px">${escapeHtml(result.rangeLabel)} · ${escapeHtml(result.scopeLabel)} · dates in ${RANGE_TIME_ZONE}</p>
<ul style="padding-left:18px">${lines.map((l) => `<li>${escapeHtml(l)}</li>`).join("")}</ul>
${attached ? `<p>${escapeHtml(attached)}</p>` : ""}
<p><a href="${escapeHtml(link)}" style="display:inline-block;background:#18181b;color:#fff;padding:8px 14px;border-radius:8px;text-decoration:none">Open the report</a></p>
<p style="color:#a1a1aa;font-size:12px">Change or stop this email in the report's schedule.</p></div>`;
  return { subject, body, html };
}

async function claim(reportId: string, staffId: string, period: LocalDate, now: Date) {
  const r = (await db.execute(sql`
    insert into saved_report_sends (report_id, staff_id, period, status, claimed_at) values (${reportId}, ${staffId}, ${period}, 'building', ${now.toISOString()})
    on conflict (report_id, staff_id, period) do update set claimed_at = excluded.claimed_at
      where saved_report_sends.status = 'building' and saved_report_sends.claimed_at < ${new Date(now.getTime() - STALE_CLAIM_MS).toISOString()}
    returning 1 ok`)) as unknown as { ok: number }[];
  return r.length > 0;
}

const sendRow = (reportId: string, staffId: string, period: LocalDate) => and(eq(savedReportSends.reportId, reportId), eq(savedReportSends.staffId, staffId), eq(savedReportSends.period, period));

/**
 * Builds and queues one person's copy of a scheduled report: under their own access, with the
 * file attached only when they may export it. Returns the job id, or null when skipped.
 */
async function deliver(r: Row, schedule: ReportSchedule, staffId: string, period: LocalDate, now: Date): Promise<string | null> {
  const skip = async () => {
    await db.update(savedReportSends).set({ status: "skipped" }).where(sendRow(r.id, staffId, period));
    return null;
  };
  const [person] = await db.select({ email: staff.email, firstName: staff.firstName, kind: staff.kind }).from(staff).where(eq(staff.id, staffId));
  const ctx = await staffContextFor(staffId);
  if (!person?.email || person.kind !== "person" || !ctx || !mayOpen(ctx, r)) return skip();
  const def = ReportDefinition.safeParse(r.definition);
  if (!def.success) return skip();
  const own = r.ownerId === staffId;
  let result: RunResult;
  let file: ExportFile | null = null;
  const why = schedule.format === "none" ? null : exportDenied(ctx, def.data.source);
  try {
    if (schedule.format !== "none" && !why) ({ file, result } = await exportReport(ctx, { id: r.id, name: r.name, definition: def.data, own }, schedule.format, { now, scheduled: true }));
    else result = await runReport(ctx, await clientPolicy(ctx), def.data, { own, now, pageSize: 1 });
  } catch {
    // Their access changed since it was scheduled (a column or location they no longer see).
    return skip();
  }
  const m = email(r, person.firstName, result, file, why);
  return db.transaction(async (tx) => {
    const [job] = await tx
      .insert(notificationJobs)
      .values({
        kind: "saved_report",
        channel: "email",
        to: person.email!,
        subject: m.subject,
        body: m.body,
        htmlBody: m.html,
        attachments: file ? [{ filename: file.filename, contentType: file.contentType.split(";")[0], content: Buffer.from(file.bytes).toString("base64") }] : null,
        runAt: now,
      })
      .returning({ id: notificationJobs.id });
    await tx.update(savedReportSends).set({ status: "queued", jobId: job.id, rows: result.total }).where(sendRow(r.id, staffId, period));
    return job.id;
  });
}

/**
 * Every due report in one go (the notifications cron fans them out as background tasks instead,
 * see src/server/jobs.ts). Each scheduled report that's due goes to each recipient once per
 * period: every recipient is claimed first, so overlapping or repeated runs never send twice, and
 * a claim left by a run that died is taken over after ten minutes. Files are dropped from the
 * outbox once sent: they hold client details, and the outbox is for checking deliveries.
 */
export async function sendDueReports(now: Date = new Date()) {
  let queued = 0;
  let skipped = 0;
  for (const d of await dueReports(now)) {
    const r = await sendReport(d.id, d.period, now);
    queued += r.queued;
    skipped += r.skipped;
  }
  return { queued, skipped };
}

/** The scheduled reports due now, each with the period it's for. */
export async function dueReports(now: Date = new Date()): Promise<{ id: string; period: LocalDate }[]> {
  const today = todayLocal(now);
  const minute = localMinutesOf(now);
  const reports = await db.select({ id: savedReports.id, schedule: savedReports.schedule }).from(savedReports).where(isNotNull(savedReports.schedule));
  return reports.flatMap((r) => {
    const s = ReportSchedule.safeParse(r.schedule);
    const period = s.success ? duePeriod(s.data, today, minute) : null;
    return period ? [{ id: r.id, period }] : [];
  });
}

/** One scheduled report's period to each of its recipients, each claimed so it goes once. */
export async function sendReport(reportId: string, period: LocalDate, now: Date = new Date()) {
  const r = await db.query.savedReports.findFirst({ where: eq(savedReports.id, reportId) });
  const s = ReportSchedule.safeParse(r?.schedule);
  if (!r || !s.success) return { queued: 0, skipped: 0 };
  const jobIds: string[] = [];
  let skipped = 0;
  for (const staffId of s.data.recipients.length ? s.data.recipients : [r.ownerId]) {
    if (!(await claim(r.id, staffId, period, now))) continue;
    const id = await deliver(r, s.data, staffId, period, now);
    if (id) jobIds.push(id);
    else skipped++;
  }
  if (jobIds.length) {
    await processDueJobs({ ids: jobIds, now });
    await db.update(notificationJobs).set({ attachments: null }).where(and(inArray(notificationJobs.id, jobIds), ne(notificationJobs.status, "pending")));
  }
  return { queued: jobIds.length, skipped };
}

export interface MorningReport {
  id: string;
  name: string;
  href: string;
  lines: string[];
}

/**
 * Reports someone put in the Morning Dashboard (their own, or ones scheduled to them), with their
 * totals as this person may see them. A report they can't run anymore is left out.
 */
export async function morningReportsFor(staffId: string, now: Date = new Date()): Promise<MorningReport[]> {
  const rows = await db
    .select()
    .from(savedReports)
    .where(and(eq(savedReports.morning, true), sql`(${savedReports.ownerId} = ${staffId} or ${savedReports.schedule} -> 'recipients' ? ${staffId})`));
  if (!rows.length) return [];
  const ctx = await staffContextFor(staffId);
  if (!ctx) return [];
  const policy = await clientPolicy(ctx);
  const out: MorningReport[] = [];
  for (const r of rows.sort((a, b) => a.name.localeCompare(b.name))) {
    const def = ReportDefinition.safeParse(r.definition);
    if (!def.success || !mayOpen(ctx, r)) continue;
    try {
      const result = await runReport(ctx, policy, def.data, { own: r.ownerId === staffId, now, pageSize: 1 });
      out.push({ id: r.id, name: r.name, href: `/admin/reports/custom/${r.id}`, lines: [`${result.rangeLabel} · ${result.scopeLabel}`, ...totalsSummary(result, def.data.summary)] });
    } catch {
      continue;
    }
  }
  return out;
}
