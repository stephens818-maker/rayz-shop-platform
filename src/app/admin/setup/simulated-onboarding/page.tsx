import type { Metadata } from "next";
import { Empty, LinkButton, Notice, PageHeader } from "@/components/ui";
import { guardPage } from "@/server/auth/staff";
import { connectMode, entityAccount, shopAccount } from "@/server/payments/connect";
import { db } from "@/db";
import { ownerEntities, shops } from "@/db/schema";
import { eq } from "drizzle-orm";
import { SimulatedOnboardingForm } from "../panels";

export const metadata: Metadata = { title: "Stripe onboarding (simulator)" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function SimulatedOnboardingPage({ searchParams }: { searchParams: Promise<{ shop?: string; owner?: string }> }) {
  const ctx = await guardPage("/admin/setup/simulated-onboarding");
  const { shop: shopId, owner: ownerId } = await searchParams;
  let target: { name: string; back: string; usable: boolean; shopId?: string; entityId?: string };
  if (ownerId) {
    if (!ctx.brandWide || !UUID.test(ownerId)) return <Empty title="Choose an owner in Location setup first" />;
    const [owner, account] = await Promise.all([db.query.ownerEntities.findFirst({ where: eq(ownerEntities.id, ownerId), columns: { id: true, name: true } }), entityAccount(ownerId)]);
    if (!owner) return <Empty title="That owner wasn't found" />;
    target = { name: owner.name, back: "/admin/setup#owners", usable: connectMode() === "simulator" && !!account?.simulated, entityId: owner.id };
  } else {
    if (!shopId || !ctx.shopIds.includes(shopId)) return <Empty title="Choose a shop in Location setup first" />;
    const [shop, account] = await Promise.all([db.query.shops.findFirst({ where: eq(shops.id, shopId), columns: { id: true, name: true } }), shopAccount(shopId)]);
    if (!shop) return <Empty title="That shop wasn't found" />;
    target = { name: shop.name, back: `/admin/setup?shop=${shop.id}&step=payments`, usable: connectMode() === "simulator" && !!account?.simulated, shopId: shop.id };
  }
  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <PageHeader
        title="Stripe onboarding"
        subtitle={target.name}
        actions={
          <LinkButton variant="ghost" href={target.back}>
            Back to setup
          </LinkButton>
        }
      />
      <Notice tone="blue">
        Stripe keys aren&apos;t set yet, so this page stands in for Stripe&apos;s hosted onboarding. Nothing is sent to Stripe and no real account is created.
      </Notice>
      {target.usable ? (
        <SimulatedOnboardingForm shopId={target.shopId} entityId={target.entityId} shopName={target.name} />
      ) : (
        <Empty title="Nothing to simulate">This account goes through Stripe&apos;s own onboarding. Start it from Location setup.</Empty>
      )}
    </div>
  );
}
