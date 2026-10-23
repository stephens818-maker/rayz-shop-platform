import { sql } from "drizzle-orm";
import { db } from "@/db";
import { AccountState, accountState } from "@/domain/connect";
import type { OwnerEntityKind } from "@/db/schema";
import type { ReportScope } from "@/server/reports";

export interface ShopAccountRow {
  shopId: string;
  shopName: string;
  ownerId: string | null;
  ownerName: string;
  ownerKind: OwnerEntityKind | null;
  stripeAccountId: string | null;
  state: AccountState;
  cardCharges: number;
  /** Card takings after refunds, tips and surcharges included: what went through the shop's account. */
  cardNetCents: number;
  cardTipsCents: number;
  surchargeCents: number;
  cardRefundsCents: number;
  /** Application fees kept by the platform on this shop's charges: the shop's processing cost. Voided and refunded charges still cost it. */
  processingFeesCents: number;
  /** cardNetCents less processingFeesCents: what the account received. */
  toAccountCents: number;
  /** Card takings from before Connect, or anything not routed to an account. */
  unroutedCardCents: number;
  payoutsPaidCents: number;
  payoutsPendingCents: number;
  cashCents: number;
  giftCardCents: number;
}

const uuids = (xs: string[]) => sql`(${sql.join(xs.length ? xs.map((i) => sql`${i}::uuid`) : [sql`null::uuid`], sql`, `)})`;

/** Per shop over the scope's dates: what went through its connected account, and what it took outside Stripe. Barber filters don't apply. */
export async function shopAccountRows(s: ReportScope): Promise<ShopAccountRow[]> {
  const ids = uuids(s.shopIds);
  const rows = (await db.execute(sql`
    with pay as (
      select p.shop_id,
        count(*) filter (where p.method = 'card' and p.status <> 'voided' and sa.status <> 'voided')::int charges,
        coalesce(sum(p.amount_cents) filter (where p.method = 'card' and p.status <> 'voided' and sa.status <> 'voided'), 0)::int card,
        coalesce(sum(p.amount_cents) filter (where p.method = 'card' and p.stripe_account_id is null and p.status <> 'voided' and sa.status <> 'voided'), 0)::int unrouted,
        coalesce(sum(p.tip_cents) filter (where p.method = 'card' and p.status <> 'voided' and sa.status <> 'voided'), 0)::int tips,
        coalesce(sum(p.card_fee_cents) filter (where p.method = 'card' and p.status <> 'voided' and sa.status <> 'voided'), 0)::int surcharge,
        coalesce(sum(p.application_fee_cents) filter (where p.method = 'card'), 0)::int fees,
        coalesce(sum(p.amount_cents) filter (where p.method = 'cash' and p.status <> 'voided' and sa.status <> 'voided'), 0)::int cash,
        coalesce(sum(p.amount_cents) filter (where p.method = 'gift_card' and p.status <> 'voided' and sa.status <> 'voided'), 0)::int gift
      from payments p join sales sa on sa.id = p.sale_id
      where p.shop_id in ${ids} and p.business_date between ${s.from} and ${s.to} and p.status not in ('pending', 'failed')
      group by p.shop_id
    ), ref as (
      select r.shop_id,
        coalesce(sum(r.amount_cents) filter (where r.method = 'card'), 0)::int card,
        coalesce(sum(r.tip_cents) filter (where r.method = 'card'), 0)::int tips,
        coalesce(sum(r.card_fee_cents) filter (where r.method = 'card'), 0)::int surcharge,
        coalesce(sum(r.amount_cents) filter (where r.method = 'card' and p.stripe_account_id is null), 0)::int unrouted,
        coalesce(sum(r.amount_cents) filter (where r.method = 'cash'), 0)::int cash,
        coalesce(sum(r.amount_cents) filter (where r.method = 'gift_card'), 0)::int gift
      from refunds r left join payments p on p.id = r.payment_id
      where r.shop_id in ${ids} and r.business_date between ${s.from} and ${s.to} and r.kind = 'refund'
      group by r.shop_id
    ), po as (
      select shop_id,
        coalesce(sum(amount_cents) filter (where status = 'paid'), 0)::int paid,
        coalesce(sum(amount_cents) filter (where status in ('pending', 'in_transit')), 0)::int pending
      from shop_payouts where shop_id in ${ids} and arrival_date between ${s.from} and ${s.to}
      group by shop_id
    )
    select sh.id "shopId", sh.name "shopName", oe.id "ownerId", coalesce(oe.name, 'No owner set') "ownerName", oe.kind "ownerKind",
      a.stripe_account_id "stripeAccountId", a.charges_enabled "chargesEnabled", a.payouts_enabled "payoutsEnabled", a.details_submitted "detailsSubmitted",
      a.requirements_due "requirementsDue", a.disabled_reason "disabledReason", a.deauthorized_at "deauthorizedAt",
      coalesce(pay.charges, 0) "cardCharges",
      coalesce(pay.card, 0) - coalesce(ref.card, 0) "cardNetCents",
      coalesce(pay.tips, 0) - coalesce(ref.tips, 0) "cardTipsCents",
      coalesce(pay.surcharge, 0) - coalesce(ref.surcharge, 0) "surchargeCents",
      coalesce(ref.card, 0) "cardRefundsCents",
      coalesce(pay.fees, 0) "processingFeesCents",
      coalesce(pay.unrouted, 0) - coalesce(ref.unrouted, 0) "unroutedCardCents",
      coalesce(po.paid, 0) "payoutsPaidCents", coalesce(po.pending, 0) "payoutsPendingCents",
      coalesce(pay.cash, 0) - coalesce(ref.cash, 0) "cashCents",
      coalesce(pay.gift, 0) - coalesce(ref.gift, 0) "giftCardCents"
    from shops sh
    left join owner_entities oe on oe.id = sh.owner_entity_id
    left join shop_payment_accounts a on a.shop_id = sh.id
    left join pay on pay.shop_id = sh.id
    left join ref on ref.shop_id = sh.id
    left join po on po.shop_id = sh.id
    where sh.id in ${ids}
    order by oe.id is null, oe.kind <> 'brand', oe.name, oe.id, sh.name`)) as unknown as (Omit<ShopAccountRow, "state" | "toAccountCents"> & {
    chargesEnabled: boolean | null;
    payoutsEnabled: boolean | null;
    detailsSubmitted: boolean | null;
    requirementsDue: string[] | null;
    disabledReason: string | null;
    deauthorizedAt: Date | null;
  })[];
  return rows.map(({ chargesEnabled, payoutsEnabled, detailsSubmitted, requirementsDue, disabledReason, deauthorizedAt, ...r }) => ({
    ...r,
    state: accountState(
      r.stripeAccountId
        ? {
            chargesEnabled: !!chargesEnabled,
            payoutsEnabled: !!payoutsEnabled,
            detailsSubmitted: !!detailsSubmitted,
            requirementsDue: requirementsDue ?? [],
            disabledReason,
            deauthorizedAt,
          }
        : null,
    ),
    toAccountCents: r.cardNetCents - r.unroutedCardCents - r.processingFeesCents,
  }));
}

export interface PayoutRow {
  shopId: string;
  shopName: string;
  stripePayoutId: string;
  amountCents: number;
  status: string;
  arrivalDate: string;
  failureMessage: string | null;
}

export async function payoutRows(s: ReportScope): Promise<PayoutRow[]> {
  return (await db.execute(sql`
    select p.shop_id "shopId", sh.name "shopName", p.stripe_payout_id "stripePayoutId", p.amount_cents "amountCents", p.status, p.arrival_date::text "arrivalDate", p.failure_message "failureMessage"
    from shop_payouts p join shops sh on sh.id = p.shop_id
    where p.shop_id in ${uuids(s.shopIds)} and p.arrival_date between ${s.from} and ${s.to}
    order by p.arrival_date desc, sh.name`)) as unknown as PayoutRow[];
}
