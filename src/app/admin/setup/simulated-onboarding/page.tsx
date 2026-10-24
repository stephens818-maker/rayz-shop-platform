import type { Metadata } from "next";
import { Empty, LinkButton, Notice, PageHeader } from "@/components/ui";
import { guardPage } from "@/server/auth/staff";
import { connectMode, shopAccount } from "@/server/payments/connect";
import { db } from "@/db";
import { shops } from "@/db/schema";
import { eq } from "drizzle-orm";
import { SimulatedOnboardingForm } from "../panels";

export const metadata: Metadata = { title: "Stripe onboarding (simulator)" };

export default async function SimulatedOnboardingPage({ searchParams }: { searchParams: Promise<{ shop?: string }> }) {
  const ctx = await guardPage("/admin/setup/simulated-onboarding");
  const { shop: shopId } = await searchParams;
  if (!shopId || !ctx.shopIds.includes(shopId)) return <Empty title="Choose a shop in Location setup first" />;
  const [shop, account] = await Promise.all([db.query.shops.findFirst({ where: eq(shops.id, shopId), columns: { id: true, name: true } }), shopAccount(shopId)]);
  if (!shop) return <Empty title="That shop wasn't found" />;
  const usable = connectMode() === "simulator" && account?.simulated;
  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <PageHeader
        title="Stripe onboarding"
        subtitle={shop.name}
        actions={
          <LinkButton variant="ghost" href={`/admin/setup?shop=${shop.id}&step=payments`}>
            Back to setup
          </LinkButton>
        }
      />
      <Notice tone="blue">
        Stripe keys aren&apos;t set yet, so this page stands in for Stripe&apos;s hosted onboarding. Nothing is sent to Stripe and no real account is created.
      </Notice>
      {usable ? (
        <SimulatedOnboardingForm shopId={shop.id} shopName={shop.name} />
      ) : (
        <Empty title="Nothing to simulate">This shop&apos;s account goes through Stripe&apos;s own onboarding. Start it from Location setup.</Empty>
      )}
    </div>
  );
}
