import type { Metadata } from "next";
import { PageHeader } from "@/components/ui";
import { guardPage } from "@/server/auth/staff";
import { promptSetup } from "@/server/checkout-prompts";
import { PromptRulesCard, PromptSettingsCard, ServicePromptsCard } from "./editor";

export const metadata: Metadata = { title: "Checkout prompts" };

export default async function CheckoutPromptsPage() {
  const ctx = await guardPage("/admin/checkout-prompts");
  const setup = await promptSetup();
  const shops = setup.shops.filter((s) => ctx.shopIds.includes(s.id));
  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <PageHeader
        title="Checkout prompts"
        subtitle="Shown on the ticket before or while it's paid: rebook the next visit with the same barber, and products used in the service or made for it. Each can be skippable or required to answer, and turned on or off for a location, a role or a barber (the most specific wins: barber, then role, then location, then the brand)."
      />
      <PromptSettingsCard settings={setup.settings} />
      <PromptRulesCard rules={setup.rules} shops={shops} roles={setup.roles} barbers={setup.barbers} />
      <ServicePromptsCard services={setup.services} products={setup.products} defaultDays={setup.settings.rebook.defaultDays} />
    </div>
  );
}
