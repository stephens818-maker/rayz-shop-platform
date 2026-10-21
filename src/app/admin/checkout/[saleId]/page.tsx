import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { feeDisclosure } from "@/domain/checkout";
import { assertShopAccess, requireStaff } from "@/server/auth/staff";
import { shopBarbers, shopCatalog } from "@/server/catalog";
import { loadCheckoutContext } from "@/server/checkout";
import { getLoyaltyConfig, loyaltyBalance } from "@/server/loyalty";
import { TEST_CARDS, paymentsMode, terminal } from "@/server/payments/processor";
import { Pos } from "./pos";

export const metadata: Metadata = { title: "Checkout" };

export default async function CheckoutPage({ params }: { params: Promise<{ saleId: string }> }) {
  const { saleId } = await params;
  const ctx = await requireStaff();
  const c = await loadCheckoutContext(saleId);
  assertShopAccess(ctx, c.shop.id);
  if (ctx.isBarber && c.sale.staffId !== ctx.staff.id) redirect("/admin/calendar");
  if (c.sale.status !== "open") redirect(`/admin/sales/${saleId}`);
  const [catalog, barbers, loyalty, loyaltyCfg] = await Promise.all([
    shopCatalog(c.shop.id),
    shopBarbers(c.shop.id),
    c.customer ? loyaltyBalance(c.customer.id) : null,
    getLoyaltyConfig(),
  ]);
  return (
    <Pos
      sale={{ id: c.sale.id, number: c.sale.number, staffId: c.sale.staffId, hasAppointment: !!c.appointment }}
      shop={{ id: c.shop.id, name: c.shop.name, taxVerified: c.shop.taxRatesVerified }}
      config={c.config}
      feeNotice={feeDisclosure(c.config.cardFee)}
      initialLines={c.items.map((i) => {
        const menu = i.kind === "product" ? c.retail.find((p) => p.productId === i.refId)?.priceCents : catalog.find((s) => s.id === i.refId)?.priceCents;
        return { kind: i.kind, refId: i.refId, name: i.name, unitPriceCents: menu ?? i.unitPriceCents, qty: i.qty };
      })}
      customer={c.customer ? { id: c.customer.id, name: `${c.customer.firstName} ${c.customer.lastName ?? ""}`.trim(), phone: c.customer.phone, notes: c.customer.notes } : null}
      barber={c.barber ? { id: c.barber.id, label: c.barber.displayLabel } : null}
      barbers={barbers.map((b) => ({ id: b.id, label: b.displayName }))}
      services={catalog.map((s) => ({ id: s.id, name: s.name, kind: s.kind, priceCents: s.priceCents }))}
      retail={c.retail}
      loyalty={
        loyalty && loyalty.enabled
          ? { rewards: loyalty.rewards, progressCents: loyalty.progressCents, thresholdCents: loyalty.thresholdCents, redeemableOn: loyaltyCfg.redeemableOn }
          : null
      }
      payments={{
        mode: paymentsMode(),
        publishableKey: process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY || null,
        terminalLabel: terminal.readerLabel,
        testCards: Object.entries(TEST_CARDS).map(([id, c]) => ({ id, label: c.label, funding: c.funding })),
      }}
      canDiscount={ctx.isAdmin || ctx.isManager}
    />
  );
}
