import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { feeDisclosure } from "@/domain/checkout";
import { can, guardPage } from "@/server/auth/staff";
import { shownBadges } from "@/server/badges";
import { noteBriefs, noteViewer } from "@/server/client-notes";
import { clientPolicy } from "@/server/client-privacy";
import { writableKinds } from "@/domain/client-notes";
import { inTenant } from "@/server/tenant";
import { shopBarbers, shopCatalog } from "@/server/catalog";
import { loadCheckoutContext } from "@/server/checkout";
import { ticketCoupons } from "@/server/coupons";
import { lookups } from "@/server/lookups";
import { getLoyaltyConfig, loyaltyBalance } from "@/server/loyalty";
import { ratingSummaries } from "@/server/ratings";
import { timesFor } from "@/server/service-times";
import { TEST_CARDS, paymentsMode, terminal } from "@/server/payments/processor";
import { settlementAccount } from "@/server/payments/connect";
import { takesCards } from "@/domain/connect";
import { and, asc, eq, isNotNull } from "drizzle-orm";
import { db } from "@/db";
import { terminalReaders } from "@/db/schema";
import { activeHandoffFor, resumeDraft, shopHandoffConfig } from "@/server/handoff";
import { ticketPeople } from "@/server/family-ticket";
import { promptsForTicket } from "@/server/checkout-prompts";
import { Pos } from "./pos";

export const metadata: Metadata = { title: "Checkout" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function CheckoutPage({ params, searchParams }: { params: Promise<{ saleId: string }>; searchParams: Promise<{ resume?: string }> }) {
  const { saleId } = await params;
  const { resume: resumeId } = await searchParams;
  const ctx = await guardPage("/admin/checkout/[saleId]");
  if (!(await inTenant(ctx, "sale", saleId))) notFound();
  const c = await loadCheckoutContext(saleId);
  if (c.sale.staffId !== ctx.staff.id && !can(ctx, "checkout.any")) redirect("/admin/calendar");
  if (c.sale.status !== "open") redirect(`/admin/sales/${saleId}`);
  const policy = await clientPolicy(ctx);
  const [catalog, barbers, loyalty, loyaltyCfg, ratings, times, lists, account, readers, handoff, withClient, resume, badges] = await Promise.all([
    shopCatalog(c.shop.id),
    shopBarbers(c.shop.id),
    c.customer ? loyaltyBalance(c.customer.id) : null,
    getLoyaltyConfig(),
    ratingSummaries([c.customer?.id]),
    timesFor(c.appointment ? [c.appointment.id] : []),
    lookups(),
    settlementAccount(c.shop),
    db
      .select({ id: terminalReaders.id, label: terminalReaders.label })
      .from(terminalReaders)
      .where(and(eq(terminalReaders.shopId, c.shop.id), eq(terminalReaders.active, true), isNotNull(terminalReaders.stripeReaderId)))
      .orderBy(asc(terminalReaders.createdAt)),
    shopHandoffConfig(c.shop.id),
    activeHandoffFor(saleId),
    resumeId && UUID.test(resumeId) ? resumeDraft(saleId, resumeId) : null,
    shownBadges(policy, [c.customer?.id]),
  ]);
  const people = await ticketPeople(c.sale);
  const prompts = await promptsForTicket(saleId, { roleId: ctx.staff.roleId, actor: ctx.actor });
  const notesViewer = noteViewer(ctx, policy);
  const briefs = await noteBriefs(notesViewer, [c.customer?.id ?? null]);
  // Rewards of anyone else on a combined ticket can pay for it too (a household shares one balance).
  const others = [...new Set(people.map((p) => p.customerId).filter((x): x is string => !!x && x !== c.customer?.id))];
  const otherBalances = loyalty?.enabled ? await Promise.all(others.map(async (id) => ({ id, b: await loyaltyBalance(id) }))) : [];
  const owners = new Set([loyalty?.ownerId].filter(Boolean));
  const otherRewards = otherBalances.flatMap(({ id, b }) => {
    if (!b.enabled || owners.has(b.ownerId)) return [];
    owners.add(b.ownerId);
    const who = people.find((p) => p.customerId === id)?.name.split(" ")[0] ?? "Guest";
    return b.rewards.map((r) => ({ ...r, owner: who }));
  });
  const payers = [
    ...(c.customer ? [{ customerId: c.customer.id, name: `${c.customer.firstName} ${c.customer.lastName ?? ""}`.trim() }] : []),
    ...people.flatMap((p) => (p.customerId && p.customerId !== c.customer?.id ? [{ customerId: p.customerId, name: p.name }] : [])),
  ].filter((p, i, a) => a.findIndex((x) => x.customerId === p.customerId) === i);
  const coupons = await ticketCoupons(c.sale);
  const cards = takesCards(c.shop.paymentsMode, account);
  return (
    <Pos
      reasons={{ discount: lists.discountReasons, priceChange: lists.priceChangeReasons }}
      sale={{ id: c.sale.id, number: c.sale.number, staffId: c.sale.staffId, hasAppointment: !!c.appointment }}
      timer={c.appointment ? { appointmentId: c.appointment.id, status: c.appointment.status, times: times.get(c.appointment.id) ?? null } : null}
      shop={{ id: c.shop.id, name: c.shop.name, taxVerified: c.shop.taxRatesVerified }}
      config={{ ...c.config, tipPresets: handoff.tips.type === "percent" ? handoff.tips.values : c.config.tipPresets }}
      feeNotice={feeDisclosure(c.config.cardFee)}
      initialLines={c.items.map((i) => {
        const menu = i.kind === "product" ? c.retail.find((p) => p.productId === i.refId)?.priceCents : catalog.find((s) => s.id === i.refId)?.priceCents;
        const family = !!i.appointmentId && i.appointmentId !== c.sale.appointmentId;
        return {
          kind: i.kind,
          refId: i.refId,
          name: i.name,
          unitPriceCents: menu ?? i.unitPriceCents,
          qty: i.qty,
          staffId: i.staffId && (family || i.staffId !== c.sale.staffId) ? i.staffId : null,
          appointmentId: i.appointmentId,
        };
      })}
      handoff={{ signature: handoff.shop.signature, unlock: handoff.shop.unlock }}
      withClient={withClient ? { by: withClient.by, startedAt: withClient.startedAt.toISOString() } : null}
      coupons={coupons}
      groupDeposit={c.groupDeposit}
      prompts={prompts}
      people={people.map((p) => ({ appointmentId: p.appointmentId, name: p.name, isChild: p.isChild, staffId: p.staffId, staffName: p.staffName, readyAt: p.readyAt?.toISOString() ?? null }))}
      payers={payers}
      canCombine={can(ctx, "checkout.any")}
      family={{
        members: c.family.members.map((m) => ({ ...m, startsAt: m.startsAt.toISOString(), readyAt: m.readyAt?.toISOString() ?? null })),
        candidates: c.family.candidates.map((m) => ({ ...m, startsAt: m.startsAt.toISOString(), readyAt: m.readyAt?.toISOString() ?? null })),
      }}
      resume={
        resume && !withClient
          ? {
              ...resume,
              lines: resume.lines.map((l) => ({
                kind: l.kind,
                refId: l.refId ?? null,
                name: l.name ?? "",
                unitPriceCents: l.unitPriceCents ?? 0,
                qty: l.qty,
                override: l.priceOverride ?? null,
                staffId: l.staffId ?? null,
                appointmentId: l.appointmentId ?? null,
              })),
            }
          : null
      }
      customer={c.customer ? { id: c.customer.id, name: `${c.customer.firstName} ${c.customer.lastName ?? ""}`.trim(), phone: policy.show("phone", c.customer.phone), rating: policy.stars(ratings.get(c.customer.id)), badges: badges.get(c.customer.id) ?? [], clientNotes: briefs.get(c.customer.id) ?? null, cutNote: writableKinds(notesViewer).includes("visit") ? { appointmentId: c.appointment?.customerId === c.customer.id ? c.appointment.id : null } : null } : null}
      barber={c.barber ? { id: c.barber.id, label: c.barber.displayLabel } : null}
      barbers={barbers.map((b) => ({ id: b.id, label: b.displayName }))}
      services={catalog.map((s) => ({ id: s.id, name: s.name, kind: s.kind, priceCents: s.priceCents }))}
      retail={c.retail}
      negativeStock={c.negativeStock}
      loyalty={
        loyalty && loyalty.enabled
          ? { rewards: [...loyalty.rewards, ...otherRewards], progressCents: loyalty.progressCents, thresholdCents: loyalty.thresholdCents, redeemableOn: loyaltyCfg.redeemableOn }
          : null
      }
      payments={{
        mode: paymentsMode(),
        publishableKey: process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY || null,
        terminalLabel: terminal.readerLabel,
        testCards: Object.entries(TEST_CARDS).map(([id, c]) => ({ id, label: c.label, funding: c.funding })),
        cards,
        noCards: cards
          ? null
          : c.shop.paymentsMode === "cash_only"
            ? `${c.shop.name} takes cash and gift cards only for now.`
            : `${c.shop.name} can't take cards until Stripe finishes approving its account. Take cash or a gift card.`,
        readers,
      }}
      taxCategories={Object.fromEntries([...catalog.map((s) => [s.id, s.taxCategory] as const), ...c.retail.map((p) => [p.productId, p.taxCategory] as const)])}
      perms={{
        discount: can(ctx, "pos.discount") && ctx.maxDiscountPct > 0,
        maxDiscountPct: ctx.maxDiscountPct,
        priceOverride: can(ctx, "pos.price_override"),
        reassign: can(ctx, "checkout.any"),
      }}
      canAdd={{ phone: policy.canAdd("phone"), email: policy.canAdd("email") }}
    />
  );
}
