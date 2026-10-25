import type { Metadata } from "next";
import { headers } from "next/headers";
import { LinkButton, PageHeader } from "@/components/ui";
import { clientIp } from "@/lib/client-ip";
import { can, guardPage, staffGrantor } from "@/server/auth/staff";
import { wizardOptions } from "@/server/location-admin";
import { geocoderName } from "@/server/geo";
import { brandInterval } from "@/server/timing";
import { loadBrandDefaults } from "@/server/location-defaults";
import { LocationWizard } from "./wizard";

export const metadata: Metadata = { title: "Add a location" };

export default async function NewLocationPage() {
  const ctx = await guardPage("/admin/setup/new");
  const [options, interval, brand] = await Promise.all([wizardOptions(staffGrantor(ctx)), brandInterval(), loadBrandDefaults()]);
  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <PageHeader
        title="Add a location"
        subtitle="Everything a new shop needs, in one pass. It's saved hidden from clients; you open it with Go live once the checklist is done."
        actions={
          <LinkButton variant="ghost" href="/admin/setup">
            Cancel
          </LinkButton>
        }
      />
      <LocationWizard
        options={options}
        brandIntervalMinutes={interval}
        brandBooking={{ minLeadMinutes: brand.minLeadMinutes, bookingWindowDays: brand.bookingWindowDays, cancelCutoffMinutes: brand.cancelCutoffMinutes }}
        canBank={can(ctx, "payments.banking")}
        geocoder={geocoderName()}
        network={can(ctx, "network.settings") ? { myIp: clientIp(await headers()), exempt: ctx.isOwner || can(ctx, "access.remote") } : null}
      />
    </div>
  );
}
