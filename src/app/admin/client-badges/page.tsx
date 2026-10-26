import type { Metadata } from "next";
import { asc } from "drizzle-orm";
import { Card, CardHeader, PageHeader } from "@/components/ui";
import { db } from "@/db";
import { roles } from "@/db/schema";
import { OWNER_ROLE_KEY } from "@/domain/permissions";
import { formatDateTime } from "@/lib/time";
import { guardPage } from "@/server/auth/staff";
import { listCustomBadges, loadBadgeSettings } from "@/server/badge-settings";
import { badgeCacheStatus } from "@/server/badges";
import { filterOptions, panelSees } from "@/server/client-filters";
import { clientPolicy } from "@/server/client-privacy";
import {
  BadgeSettingsEditor,
  CustomBadgesEditor,
  RecomputeButton,
} from "./editor";

export const metadata: Metadata = { title: "Client badges" };
export const dynamic = "force-dynamic";

export default async function ClientBadgesPage() {
  const ctx = await guardPage("/admin/client-badges");
  const policy = await clientPolicy(ctx);
  const [settings, custom, roleRows, status, options] = await Promise.all([
    loadBadgeSettings(ctx.brandWide ? null : ctx.currentShopId),
    listCustomBadges({ shopId: ctx.brandWide ? null : ctx.currentShopId }),
    db
      .select({
        id: roles.id,
        name: roles.name,
        key: roles.key,
        brandLevel: roles.brandLevel,
      })
      .from(roles)
      .orderBy(asc(roles.sortOrder), asc(roles.name)),
    badgeCacheStatus(),
    filterOptions(ctx, policy),
  ]);
  const shownRoles = roleRows.filter((r) => r.key !== OWNER_ROLE_KEY);
  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <PageHeader
        title="Client badges"
        subtitle="Small labels on client profiles, calendar appointments, checkout, the client list and search results that say where each client stands: due, at risk, 2nd visit, VIP, birthday this week. Hover a badge to see why the client has it. A badge never shows a client detail the person can't see under Client data."
      />
      <div className="grid gap-4 lg:grid-cols-[1fr_18rem]">
        <BadgeSettingsEditor
          initial={settings}
          roles={shownRoles}
          custom={custom}
          readOnly={!ctx.brandWide}
        />
        <div className="space-y-4 self-start">
          <Card>
            <CardHeader
              title="Cache"
              subtitle="Worked out every night and right after each checkout, so screens read them instantly."
            />
            <div
              className="space-y-2 px-4 py-3 text-sm text-zinc-700"
              data-testid="badge-cache"
            >
              <div>
                <span className="font-semibold tabular">
                  {status.fresh.toLocaleString("en-US")}
                </span>{" "}
                of {status.clients.toLocaleString("en-US")} clients up to date
                today
              </div>
              <div className="text-xs text-zinc-500">
                {status.last
                  ? `Last worked out ${formatDateTime(status.last)}`
                  : "Not worked out yet."}
              </div>
              <p className="text-xs text-zinc-500">
                Changing a threshold or a custom badge marks every client for
                recomputing. Screens recompute the clients they show at once;
                filters and counts catch up overnight, or now:
              </p>
              <RecomputeButton />
            </div>
          </Card>
          <Card>
            <CardHeader title="Who sees what" />
            <ul className="list-disc space-y-1 px-8 py-3 text-xs text-zinc-600">
              <li>The Brand Owner sees every badge that&apos;s on.</li>
              <li>
                Someone working across several locations sees a badge only if
                every role they&apos;re working under does.
              </li>
              <li>
                VIP and Gift card show spend, so they also need &quot;Look up
                any client in the brand&quot;. VIP starts shown to brand-level
                roles only.
              </li>
              <li>
                Birthday this week needs the whole birthday; Birthday this month
                needs at least its month. Barber badges need preferred barbers,
                Low rating needs ratings, and Missing info needs phone and
                email, at least masked. Barber names show only to people who see
                preferred barbers in full.
              </li>
              <li>
                A custom badge shows only to people who could run its filter
                themselves.
              </li>
              <li>
                Customers see only the badges ticked under &quot;Customers
                see&quot;, in their own wording, with the day they earned each
                and progress toward the next (&quot;2 more visits to
                Gold&quot;), in their account, on the booking site and in the
                app. Low rating, How they found us, No product yet and custom
                badges built on ratings are staff-only always.
              </li>
            </ul>
          </Card>
        </div>
      </div>
      <CustomBadgesEditor
        list={custom}
        options={options}
        sees={panelSees(ctx, policy)}
        brand={ctx.brandWide}
      />
    </div>
  );
}
