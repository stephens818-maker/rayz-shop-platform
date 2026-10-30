import type { Metadata } from "next";
import { and, asc, inArray, ne } from "drizzle-orm";
import { db } from "@/db";
import { shops } from "@/db/schema";
import { Card, CardHeader, Empty, PageHeader } from "@/components/ui";
import { NO_RETALIATION, PAY_AGENCIES, PAY_QUESTION_MANAGER_DAYS, PAY_QUESTION_OWNER_DAYS } from "@/domain/staff-privacy";
import { formatDate, todayLocal } from "@/lib/time";
import { workShopIds } from "@/server/auth/access";
import { can, guardPage } from "@/server/auth/staff";
import { answersPayQuestions, myPayQuestions, teamPayQuestions } from "@/server/pay-questions";
import { recentPeriods } from "@/server/time-clock";
import { AskForm, QuestionCard, type QuestionView } from "./client";

export const metadata: Metadata = { title: "Pay questions" };

const plain = (q: Awaited<ReturnType<typeof myPayQuestions>>[number]): QuestionView => ({ ...q, dueAt: q.dueAt.toISOString() });

export default async function PayQuestionsPage() {
  const ctx = await guardPage("/admin/pay-questions");
  const person = ctx.staff.kind === "person";
  const asks = person && can(ctx, "timesheet.own");
  const answers = answersPayQuestions(ctx);
  const viewer = { staffId: ctx.staff.id, actor: ctx.actor, isOwner: ctx.isOwner, shopIds: ctx.shopIds, permissions: ctx.permissions };
  const [mine, team, myShops, periods] = await Promise.all([
    asks ? myPayQuestions(ctx.staff.id) : Promise.resolve([]),
    answers ? teamPayQuestions(viewer, { open: false }) : Promise.resolve([]),
    asks ? workShopIds(ctx.staff.id) : Promise.resolve([]),
    asks ? recentPeriods(todayLocal(), 6) : Promise.resolve([]),
  ]);
  const shopRows = myShops.length ? await db.select({ id: shops.id, name: shops.name }).from(shops).where(and(inArray(shops.id, myShops), ne(shops.status, "archived"))).orderBy(asc(shops.name)) : [];
  const recent = new Date(Date.now() - 60 * 86_400_000);
  const teamShown = team.filter((q) => q.status !== "resolved" || q.createdAt > recent);
  return (
    <div className="space-y-6">
      <PageHeader
        title="Pay questions"
        subtitle={`Questions about pay go to the managers who approve timecards at that shop, who answer within ${PAY_QUESTION_MANAGER_DAYS} days. Unanswered, or when the employee asks, they go to the owners, who answer within ${PAY_QUESTION_OWNER_DAYS} days.`}
      />
      {asks && (
        <Card>
          <CardHeader title="Ask about my pay" subtitle={NO_RETALIATION} />
          {shopRows.length ? (
            <AskForm shops={shopRows} periods={periods.map((p) => ({ start: p.start, label: `${formatDate(p.start, "MMM d")} – ${formatDate(p.end, "MMM d")}` }))} />
          ) : (
            <p className="p-4 text-sm text-zinc-500">You aren&apos;t on a shop&apos;s team yet.</p>
          )}
          {mine.length > 0 && <ul className="divide-y divide-zinc-100 border-t border-zinc-100">{mine.map((q) => <QuestionCard key={q.id} q={plain(q)} mine />)}</ul>}
          <p className="border-t border-zinc-100 p-4 text-xs text-zinc-500">
            You can also go to an outside agency at any time:{" "}
            {PAY_AGENCIES.map((a, i) => (
              <span key={a.state}>
                {i ? "; " : ""}
                <a className="underline" href={a.url}>
                  {a.name}
                </a>
                {"phone" in a ? ` (${a.phone})` : ""}
              </span>
            ))}
            .
          </p>
        </Card>
      )}
      {answers && (
        <Card>
          <CardHeader title="The team's questions" subtitle="Open first. Escalated questions are answered by the owners." />
          {teamShown.length ? (
            <ul className="divide-y divide-zinc-100">
              {teamShown.map((q) => (
                <QuestionCard key={q.id} q={plain(q)} mine={false} />
              ))}
            </ul>
          ) : (
            <Empty title="No pay questions">Nobody at your shops has asked one lately.</Empty>
          )}
        </Card>
      )}
    </div>
  );
}
