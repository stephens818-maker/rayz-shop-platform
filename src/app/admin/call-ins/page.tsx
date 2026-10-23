import type { Metadata } from "next";
import Link from "next/link";
import { and, asc, inArray, ne } from "drizzle-orm";
import { db } from "@/db";
import { shops } from "@/db/schema";
import { ReasonTag } from "@/components/reason-picker";
import { Badge, Card, CardHeader, Empty, PageHeader, Table, Td, Th } from "@/components/ui";
import { CALL_IN_KIND_LABEL, quietLabel } from "@/domain/outreach";
import { todayLocal } from "@/lib/time";
import { can, guardPage, reasonViewer } from "@/server/auth/staff";
import { barbersAt } from "@/server/barbers";
import { pickerReasons } from "@/server/block-reasons";
import { listCallIns, loadOutreachRules } from "@/server/call-ins";
import { MarkCallIn, OutreachRulesEditor } from "./client";

export const metadata: Metadata = { title: "Call-ins" };

export default async function CallInsPage() {
  const ctx = await guardPage("/admin/call-ins");
  const now = new Date();
  const markOthers = can(ctx, "callins.mark");
  const markOwn = can(ctx, "callins.mark_own");
  const [list, barbers, reasons, shopRows, rules] = await Promise.all([
    listCallIns(ctx.shopIds, { since: new Date(now.getTime() - 14 * 86_400_000), viewer: reasonViewer(ctx) }),
    barbersAt(ctx.shopIds),
    pickerReasons("time_off"),
    db.select({ id: shops.id, name: shops.name }).from(shops).where(and(inArray(shops.id, ctx.shopIds), ne(shops.status, "archived"))).orderBy(asc(shops.name)),
    loadOutreachRules(),
  ]);
  const markable = barbers.filter((b) => b.active && (markOthers || (markOwn && b.id === ctx.staff.id)));
  const open = list.filter((c) => !c.cancelledAt && c.endsAt > now);
  const past = list.filter((c) => !open.includes(c));
  return (
    <div className="space-y-6">
      <PageHeader
        title="Call-ins"
        subtitle="When a barber calls in sick or can't make it: mark the time off, see every client booked in it, and move them, send a rebook link or call them automatically."
      />

      {(markOthers || markOwn) && markable.length > 0 && (
        <MarkCallIn today={todayLocal(now)} barbers={markable.map((b) => ({ id: b.id, name: b.name, shopIds: b.shopIds }))} shops={shopRows} reasons={reasons} me={ctx.staff.id} />
      )}

      <Card>
        <CardHeader title="Current and upcoming" subtitle="Open one to contact the clients." />
        {open.length === 0 ? (
          <div className="p-4">
            <Empty title="Nobody is called in" />
          </div>
        ) : (
          <CallInTable rows={open} />
        )}
      </Card>

      {past.length > 0 && (
        <Card>
          <CardHeader title="Last two weeks" />
          <CallInTable rows={past} />
        </Card>
      )}

      {can(ctx, "settings.brand") && ctx.brandWide ? (
        <OutreachRulesEditor rules={rules} />
      ) : (
        <p className="text-sm text-zinc-500">
          Follow-up after {rules.retryAfterHours} h without an answer, then flagged for staff. Quiet hours: {quietLabel(rules)}. Rebook links last {rules.linkTtlHours} h.
        </p>
      )}
    </div>
  );
}

function CallInTable({ rows }: { rows: Awaited<ReturnType<typeof listCallIns>> }) {
  return (
    <Table>
      <thead>
        <tr>
          <Th>Barber</Th>
          <Th>When</Th>
          <Th>Reason</Th>
          <Th>Where</Th>
          <Th right>Appointments</Th>
          <Th>Outreach</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((c) => {
          const done = (c.by.rebooked ?? 0) + (c.by.declined ?? 0) + (c.by.cancelled ?? 0);
          return (
            <tr key={c.id}>
              <Td className="font-medium">
                <Link className="underline-offset-2 hover:underline" href={`/admin/call-ins/${c.id}`}>
                  {c.staffLabel}
                </Link>
              </Td>
              <Td>{c.range}</Td>
              <Td>
                <span className="inline-flex items-center gap-1.5">
                  <ReasonTag reason={c.reasonShown} />
                  {!c.reasonShown.hidden && c.kind !== "other" && c.reasonShown.label !== CALL_IN_KIND_LABEL[c.kind] && <span className="text-xs text-zinc-500">{CALL_IN_KIND_LABEL[c.kind]}</span>}
                </span>
              </Td>
              <Td>{c.shopName ?? "All their shops"}</Td>
              <Td right>{c.total}</Td>
              <Td>
                {c.cancelledAt ? (
                  <Badge>cancelled</Badge>
                ) : c.total === 0 ? (
                  <span className="text-zinc-500">Nobody booked</span>
                ) : (
                  <span className="inline-flex flex-wrap gap-1">
                    {(c.by.pending ?? 0) > 0 && <Badge tone="amber">{c.by.pending} not contacted</Badge>}
                    {done > 0 && <Badge tone="green">{done} done</Badge>}
                    {c.flagged > 0 && <Badge tone="red">{c.flagged} need staff</Badge>}
                  </span>
                )}
              </Td>
            </tr>
          );
        })}
      </tbody>
    </Table>
  );
}
