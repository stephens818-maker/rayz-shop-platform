import type { Metadata } from "next";
import { asc, inArray } from "drizzle-orm";
import { db } from "@/db";
import { shopCutovers, shops } from "@/db/schema";
import { Card, CardHeader, Empty, LinkButton, Notice, PageHeader, Select, Stat, buttonClass } from "@/components/ui";
import { CHANNEL_CHOICE_LABEL, ONBOARDING_LABEL, stillToDo } from "@/domain/staff-onboarding";
import { formatCents } from "@/lib/money";
import { formatDate, formatDateTime, todayLocal } from "@/lib/time";
import { guardPage, reportShopIds } from "@/server/auth/staff";
import { OnboardingRow, onboardingRoster } from "@/server/tips/onboarding";
import { taxFormStatus } from "@/server/tips/accounts";
import { flags } from "@/lib/flags";
import { stripePayoutsOn } from "@/server/tips/payout-model";
import { OnboardingTracker, TrackerRow } from "./client";

export const metadata: Metadata = { title: "Payout onboarding" };

const contactOf = (r: OnboardingRow) => (r.hasEmail && r.hasPhone ? "Email and mobile on file" : r.hasEmail ? "Email on file, no mobile" : r.hasPhone ? "Mobile on file, no email" : "No email or mobile: add one to invite them");

function invitedOf(r: OnboardingRow) {
  if (!r.invite) return null;
  const how = r.invite.channels.map((c) => CHANNEL_CHOICE_LABEL[c].toLowerCase()).join(" and ");
  const times = r.invite.invites > 1 ? ` · ${r.invite.invites} invites, first ${formatDate(r.invite.firstSentAt, "MMM d")}` : "";
  return `${formatDateTime(r.invite.lastSentAt)} by ${how}${times}`;
}

function remindersOf(r: OnboardingRow) {
  if (!r.invite) return null;
  const sent = `${r.invite.reminders} sent`;
  if (r.progress === "done") return sent;
  if (r.invite.remindersStoppedAt) return `${sent} · stopped ${formatDate(r.invite.remindersStoppedAt, "MMM d")}`;
  if (r.progress === "verifying") return `${sent} · paused while Stripe verifies`;
  return r.nextReminderAt ? `${sent} · next ${formatDateTime(r.nextReminderAt)}` : `${sent} · no more scheduled`;
}

export default async function PayoutOnboardingPage({ searchParams }: { searchParams: Promise<{ shop?: string }> }) {
  const ctx = await guardPage("/admin/tips/onboarding");
  if (!stripePayoutsOn() || !flags.tipToBarber())
    return (
      <Empty title="Payout onboarding is switched off">
        Tips to barbers&rsquo; Stripe accounts are switched off on this deployment, so tips are paid through payroll (the iSolved export) and nobody has a payout account to set up.
      </Empty>
    );
  const sp = await searchParams;
  const shopIds = reportShopIds(ctx, sp.shop ?? (ctx.currentShopId ? ctx.currentShopId : "all"));
  if (!shopIds.length) return <Empty title="No shop selected" />;
  const today = todayLocal();
  const [roster, names, ends, tax] = await Promise.all([
    onboardingRoster(shopIds),
    db.select({ id: shops.id, name: shops.name }).from(shops).where(inArray(shops.id, ctx.shopIds)).orderBy(asc(shops.name)),
    db.select({ shopId: shopCutovers.shopId, end: shopCutovers.squireTipsEndOn }).from(shopCutovers).where(inArray(shopCutovers.shopId, shopIds)),
    ctx.brandWide ? taxFormStatus() : null,
  ]);
  const { counts, total, waitingCents } = roster;
  const rows = roster.rows.filter((r) => r.onboardingOpen);
  const hidden = roster.rows.length - rows.length;
  const label = shopIds.length === 1 ? (names.find((n) => n.id === shopIds[0])?.name ?? "This shop") : shopIds.length === ctx.shopIds.length ? "Every shop" : `${shopIds.length} shops`;
  const upcoming = ends
    .filter((e) => e.end && e.end >= today)
    .map((e) => ({ name: names.find((n) => n.id === e.shopId)?.name ?? "A shop", end: e.end!, left: rows.filter((r) => stillToDo(r.progress) && r.shops.some((s) => s.id === e.shopId)).length }))
    .sort((a, b) => a.end.localeCompare(b.end));
  const tracker: TrackerRow[] = rows
    .map((r) => ({
      staffId: r.staffId,
      name: r.name,
      shops: r.shops.map((s) => s.name).join(", "),
      progress: r.progress,
      noContact: !r.hasEmail && !r.hasPhone,
      contact: contactOf(r),
      invited: invitedOf(r),
      reminders: remindersOf(r),
      canStopReminders: !!r.invite && !r.invite.remindersStoppedAt && stillToDo(r.progress),
      waiting: r.waitingCents > 0 ? `${formatCents(r.waitingCents)} (${r.waitingPayouts} payout${r.waitingPayouts === 1 ? "" : "s"})` : null,
      needs: r.needs,
      stripeDeadline: r.stripeDeadline ? formatDateTime(r.stripeDeadline) : null,
      squireDeadline: r.squireTipsEndOn ? formatDate(r.squireTipsEndOn, "EEE, MMM d") : null,
    }))
    .sort((a, b) => Number(!stillToDo(a.progress)) - Number(!stillToDo(b.progress)) || a.name.localeCompare(b.name));
  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <PageHeader
        title="Payout onboarding"
        subtitle={`${label}. Everyone sets up a new Stripe payout account under Ray'z; no Squire account carries over. Bank and card details stay with Stripe.`}
        actions={
          <LinkButton variant="secondary" href="/admin/tips">
            Tip payouts
          </LinkButton>
        }
      />
      <form method="get" className="flex flex-wrap items-end gap-2">
        <label className="text-sm text-zinc-700">
          <span className="mb-1 block text-xs font-medium text-zinc-500">Shop</span>
          <Select name="shop" defaultValue={shopIds.length === 1 ? shopIds[0] : "all"} className="w-72">
            {ctx.shopIds.length > 1 && <option value="all">{ctx.brandWide ? "Every shop" : "All my shops"}</option>}
            {names.map((n) => (
              <option key={n.id} value={n.id}>
                {n.name}
              </option>
            ))}
          </Select>
        </label>
        <button type="submit" className={buttonClass("secondary")}>
          Show
        </button>
      </form>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-7">
        <Stat label={ONBOARDING_LABEL.done} value={`${counts.done} of ${total}`} hint="Stripe can pay them" />
        <Stat label={ONBOARDING_LABEL.verifying} value={String(counts.verifying)} hint="their part is done" />
        <Stat label={ONBOARDING_LABEL.blocked} value={String(counts.blocked)} hint="Stripe needs more" tone={counts.blocked ? "down" : undefined} />
        <Stat label={ONBOARDING_LABEL.started} value={String(counts.started)} hint="opened Stripe, not finished" />
        <Stat label={ONBOARDING_LABEL.invited} value={String(counts.invited)} hint="haven't started" />
        <Stat label={ONBOARDING_LABEL.not_invited} value={String(counts.not_invited)} tone={counts.not_invited ? "down" : undefined} />
        <Stat label="Tips waiting" value={formatCents(waitingCents)} hint="approved, sent once they finish" />
      </div>
      {hidden > 0 && (
        <Notice tone="blue">
          {hidden} {hidden === 1 ? "person works" : "people work"} only at shops with tips to barbers turned off (Tip payout settings), so payout setup isn&rsquo;t offered to them: their tips are paid through payroll.
        </Notice>
      )}
      {upcoming.map((u) => (
        <Notice key={u.name} tone={u.left ? "amber" : "green"}>
          {u.name}: Squire stops paying tips on {formatDate(u.end, "EEEE, MMM d")}.{" "}
          {u.left ? `${u.left} ${u.left === 1 ? "person still has" : "people still have"} to finish payout setup.` : "Everyone there is set up."}
        </Notice>
      ))}
      <Card>
        <CardHeader
          title="Who's set up"
          subtitle="Invites go by text, email or both; whoever lacks the one you pick gets the other. Reminders follow every few days (Tip payout settings) until they're done, 9 AM to 7 PM. Tips approved for someone who isn't done wait in a held payout and go out on their own once they finish."
        />
        {tracker.length ? <OnboardingTracker rows={tracker} /> : <p className="px-4 py-6 text-sm text-zinc-500">No one on the team here yet.</p>}
      </Card>
      {tax && (
        <Card>
          <CardHeader
            title="No 1099s for employees"
            subtitle="Tips are W-2 wages through payroll, so Stripe mustn't send employees a 1099 for them. Every account is made with Ray'z paying its Stripe fees (no 1099-K) and tagged as a W-2 employee's."
            action={
              // A CSV download (route handler), not a page; the rule reads /admin/tips/[id] as matching it.
              // eslint-disable-next-line @next/next/no-html-link-for-pages
              <a className={buttonClass("secondary")} href="/admin/tips/onboarding/tax-forms">
                Download 1099 exclusions
              </a>
            }
          />
          <div className="space-y-2 px-4 py-3 text-sm">
            {tax.feesOnAccount > 0 && (
              <Notice tone="red">
                {tax.feesOnAccount} account{tax.feesOnAccount === 1 ? " pays" : "s pay"} its own Stripe fees, so Stripe would send a 1099-K. Their Stripe payouts are held; ask Stripe support to
                move the fees to Ray&apos;z, then release them on Tip payouts.
              </Notice>
            )}
            {tax.untagged > 0 && <Notice>{tax.untagged} account{tax.untagged === 1 ? " is" : "s are"} waiting for Stripe to confirm the W-2 tags; they&apos;re added on the next update.</Notice>}
            <p className="text-zinc-600">
              {tax.accounts} employee Stripe account{tax.accounts === 1 ? "" : "s"}. Each January before Stripe files (and after new people onboard), import the exclusions file in the Stripe
              Dashboard: Tax reporting → Import → pick each 1099 form type Stripe prepared → Update. It sets every employee account to not file and not mail a form. Account ids only.
            </p>
          </div>
        </Card>
      )}
    </div>
  );
}
