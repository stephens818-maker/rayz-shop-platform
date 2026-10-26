import { sql } from "drizzle-orm";
import { db } from "@/db";
import { AccountState, accountState, takesCards } from "@/domain/connect";
import type { OwnerEntityKind, PaymentsMode } from "@/db/schema";
import type { ReportScope } from "@/server/reports";

export interface ShopAccountRow {
  shopId: string;
  shopName: string;
  ownerId: string | null;
  ownerName: string;
  ownerKind: OwnerEntityKind | null;
  stripeAccountId: string | null;
  /** The owner entity's own connected account, which shops in payments mode "entity" share. */
  ownerAccountId: string | null;
  /** Where the shop's card money goes now. Earlier charges stay where they settled. */
  paymentsMode: PaymentsMode;
  state: AccountState;
  canCharge: boolean;
  cardCharges: number;
  /** Card takings after refunds, tips and surcharges included: what went through the shop's account or the brand's. */
  cardNetCents: number;
  /** The part of cardNetCents that settled in the brand's own Stripe account. */
  brandSettledCents: number;
  /** The part of processingFeesCents on charges that settled in the brand's account. */
  brandFeesCents: number;
  /** The part of cardNetCents that settled in an owner entity's account. */
  entitySettledCents: number;
  /** The part of processingFeesCents on charges that settled in an owner entity's account. */
  entityFeesCents: number;
  cardTipsCents: number;
  surchargeCents: number;
  /** Surcharges staff waived on card charges: what they would have been. */
  surchargeWaivedCents: number;
  cardRefundsCents: number;
  /**
   * The shop's processing cost: application fees on charges to its own account, Stripe's fee on charges
   * to the brand's. Voided and refunded charges still cost it.
   */
  processingFeesCents: number;
  /** cardNetCents less unrouted takings and processingFeesCents: what the accounts received. */
  toAccountCents: number;
  /** Card takings from before Connect that aren't tied to any account. */
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
    with eacct as (select stripe_account_id from entity_payment_accounts), pay as (
      select p.shop_id,
        count(*) filter (where p.method = 'card' and p.status <> 'voided' and sa.status <> 'voided')::int charges,
        coalesce(sum(p.amount_cents) filter (where p.method = 'card' and p.status <> 'voided' and sa.status <> 'voided'), 0)::int card,
        coalesce(sum(p.amount_cents) filter (where p.method = 'card' and p.stripe_account_id is null and p.settlement is distinct from 'platform' and p.status <> 'voided' and sa.status <> 'voided'), 0)::int unrouted,
        coalesce(sum(p.amount_cents) filter (where p.method = 'card' and p.settlement = 'platform' and p.status <> 'voided' and sa.status <> 'voided'), 0)::int brand,
        coalesce(sum(p.tip_cents) filter (where p.method = 'card' and p.status <> 'voided' and sa.status <> 'voided'), 0)::int tips,
        coalesce(sum(p.card_fee_cents) filter (where p.method = 'card' and p.status <> 'voided' and sa.status <> 'voided'), 0)::int surcharge,
        coalesce(sum(p.fee_waived_cents) filter (where p.method = 'card' and p.status <> 'voided' and sa.status <> 'voided'), 0)::int waived,
        coalesce(sum(case when p.settlement = 'platform' then p.processor_fee_cents else p.application_fee_cents end) filter (where p.method = 'card'), 0)::int fees,
        coalesce(sum(p.processor_fee_cents) filter (where p.method = 'card' and p.settlement = 'platform'), 0)::int brand_fees,
        coalesce(sum(p.amount_cents) filter (where p.method = 'card' and p.stripe_account_id in (select * from eacct) and p.status <> 'voided' and sa.status <> 'voided'), 0)::int entity,
        coalesce(sum(p.application_fee_cents) filter (where p.method = 'card' and p.stripe_account_id in (select * from eacct)), 0)::int entity_fees,
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
        coalesce(sum(r.amount_cents) filter (where r.method = 'card' and p.stripe_account_id is null and p.settlement is distinct from 'platform'), 0)::int unrouted,
        coalesce(sum(r.amount_cents) filter (where r.method = 'card' and p.settlement = 'platform'), 0)::int brand,
        coalesce(sum(r.amount_cents) filter (where r.method = 'card' and p.stripe_account_id in (select * from eacct)), 0)::int entity,
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
      a.stripe_account_id "stripeAccountId", ea.stripe_account_id "ownerAccountId", sh.payments_mode "paymentsMode",
      sa.stripe_account_id "settlementAccountId", sa.charges_enabled "chargesEnabled", sa.payouts_enabled "payoutsEnabled", sa.details_submitted "detailsSubmitted",
      sa.requirements_due "requirementsDue", sa.disabled_reason "disabledReason", sa.deauthorized_at "deauthorizedAt",
      coalesce(pay.charges, 0) "cardCharges",
      coalesce(pay.card, 0) - coalesce(ref.card, 0) "cardNetCents",
      coalesce(pay.brand, 0) - coalesce(ref.brand, 0) "brandSettledCents",
      coalesce(pay.tips, 0) - coalesce(ref.tips, 0) "cardTipsCents",
      coalesce(pay.surcharge, 0) - coalesce(ref.surcharge, 0) "surchargeCents",
      coalesce(pay.waived, 0) "surchargeWaivedCents",
      coalesce(ref.card, 0) "cardRefundsCents",
      coalesce(pay.fees, 0) "processingFeesCents",
      coalesce(pay.brand_fees, 0) "brandFeesCents",
      coalesce(pay.entity, 0) - coalesce(ref.entity, 0) "entitySettledCents",
      coalesce(pay.entity_fees, 0) "entityFeesCents",
      coalesce(pay.unrouted, 0) - coalesce(ref.unrouted, 0) "unroutedCardCents",
      coalesce(po.paid, 0) "payoutsPaidCents", coalesce(po.pending, 0) "payoutsPendingCents",
      coalesce(pay.cash, 0) - coalesce(ref.cash, 0) "cashCents",
      coalesce(pay.gift, 0) - coalesce(ref.gift, 0) "giftCardCents"
    from shops sh
    left join owner_entities oe on oe.id = sh.owner_entity_id
    left join shop_payment_accounts a on a.shop_id = sh.id
    left join entity_payment_accounts ea on ea.owner_entity_id = sh.owner_entity_id
    left join lateral (
      select x.stripe_account_id, x.charges_enabled, x.payouts_enabled, x.details_submitted, x.requirements_due, x.disabled_reason, x.deauthorized_at
      from (select a.stripe_account_id, a.charges_enabled, a.payouts_enabled, a.details_submitted, a.requirements_due, a.disabled_reason, a.deauthorized_at where sh.payments_mode <> 'entity'
            union all
            select ea.stripe_account_id, ea.charges_enabled, ea.payouts_enabled, ea.details_submitted, ea.requirements_due, ea.disabled_reason, ea.deauthorized_at where sh.payments_mode = 'entity') x
    ) sa on true
    left join pay on pay.shop_id = sh.id
    left join ref on ref.shop_id = sh.id
    left join po on po.shop_id = sh.id
    where sh.id in ${ids}
    order by oe.id is null, not oe.is_default, oe.kind <> 'brand', oe.name, oe.id, sh.name`)) as unknown as (Omit<ShopAccountRow, "state" | "canCharge" | "toAccountCents"> & {
    settlementAccountId: string | null;
    chargesEnabled: boolean | null;
    payoutsEnabled: boolean | null;
    detailsSubmitted: boolean | null;
    requirementsDue: string[] | null;
    disabledReason: string | null;
    deauthorizedAt: Date | null;
  })[];
  return rows.map(({ settlementAccountId, chargesEnabled, payoutsEnabled, detailsSubmitted, requirementsDue, disabledReason, deauthorizedAt, ...r }) => {
    const flags = settlementAccountId
      ? {
          chargesEnabled: !!chargesEnabled,
          payoutsEnabled: !!payoutsEnabled,
          detailsSubmitted: !!detailsSubmitted,
          requirementsDue: requirementsDue ?? [],
          disabledReason,
          deauthorizedAt,
        }
      : null;
    return { ...r, state: accountState(flags), canCharge: takesCards(r.paymentsMode, flags), toAccountCents: r.cardNetCents - r.unroutedCardCents - r.processingFeesCents };
  });
}

export interface PayoutRow {
  id: string;
  /** Null for a payout from the brand's own account, which pools every brand-account shop, or from an owner entity's. */
  shopId: string | null;
  /** Set for a payout from an owner entity's account, which pools that owner's shops in payments mode "entity". */
  ownerEntityId: string | null;
  shopName: string;
  stripeAccountId: string;
  stripePayoutId: string;
  amountCents: number;
  status: string;
  arrivalDate: string;
  failureMessage: string | null;
  grossCents: number | null;
  feeCents: number | null;
  refundCents: number | null;
  itemCount: number | null;
}

/** Owner entities every one of whose shops is in `shopIds`: their pooled account's payouts are safe to show. */
export async function coveredOwners(shopIds: readonly string[]): Promise<string[]> {
  if (!shopIds.length) return [];
  const rows = (await db.execute(sql`
    select owner_entity_id id from shops group by owner_entity_id having bool_and(id in ${uuids([...shopIds])})`)) as unknown as { id: string }[];
  return rows.map((r) => r.id);
}

/** Payouts arriving in the scope's dates. With `brand`, the brand account's pooled payouts too; with `owners`, those owners' pooled payouts. */
export async function payoutRows(s: ReportScope, o: { brand?: boolean; owners?: string[] } = {}): Promise<PayoutRow[]> {
  const owners = o.owners?.length ? sql` or p.owner_entity_id in ${uuids(o.owners)}` : sql``;
  return (await db.execute(sql`
    select p.id, p.shop_id "shopId", p.owner_entity_id "ownerEntityId", coalesce(sh.name, oe.name || ' (owner account)', 'Brand account') "shopName", p.stripe_account_id "stripeAccountId", p.stripe_payout_id "stripePayoutId",
      p.amount_cents "amountCents", p.status, p.arrival_date::text "arrivalDate", p.failure_message "failureMessage",
      p.gross_cents "grossCents", p.fee_cents "feeCents", p.refund_cents "refundCents", p.item_count "itemCount"
    from shop_payouts p left join shops sh on sh.id = p.shop_id left join owner_entities oe on oe.id = p.owner_entity_id
    where (p.shop_id in ${uuids(s.shopIds)}${o.brand ? sql` or (p.shop_id is null and p.owner_entity_id is null)` : sql``}${owners}) and p.arrival_date between ${s.from} and ${s.to}
    order by p.arrival_date desc, p.shop_id is null, p.owner_entity_id is null, sh.name, oe.name`)) as unknown as PayoutRow[];
}
