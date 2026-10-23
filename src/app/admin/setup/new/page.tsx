import type { Metadata } from "next";
import { LinkButton, PageHeader } from "@/components/ui";
import { guardPage, staffGrantor } from "@/server/auth/staff";
import { wizardOptions } from "@/server/location-admin";
import { brandInterval } from "@/server/timing";
import { LocationWizard } from "./wizard";

export const metadata: Metadata = { title: "Add a location" };

export default async function NewLocationPage() {
  const ctx = await guardPage("/admin/setup/new");
  const [options, interval] = await Promise.all([wizardOptions(staffGrantor(ctx)), brandInterval()]);
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
      <LocationWizard options={options} brandIntervalMinutes={interval} />
    </div>
  );
}
