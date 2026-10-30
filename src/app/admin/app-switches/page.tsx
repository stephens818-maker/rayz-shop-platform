import type { Metadata } from "next";
import { Card, CardHeader, PageHeader } from "@/components/ui";
import { brandColumn } from "@/server/brand-sync/settings";
import { APP_SWITCHES, APP_SWITCH_LABEL, envKilled, switchesFrom } from "@/server/app-switches";
import { guardPage } from "@/server/auth/staff";
import { SwitchToggle } from "./client";

export const metadata: Metadata = { title: "App switches" };

export default async function AppSwitchesPage() {
  await guardPage("/admin/app-switches");
  const stored = (await brandColumn("appSwitches")) ?? {};
  const killed = envKilled();
  const now = switchesFrom(stored);
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <PageHeader
        title="App switches"
        subtitle="Turn a part of the customer app and website off at once if something goes wrong, with no app update. It takes effect within a few seconds. Staff screens aren't affected, and a single shop's booking is its own switch under Shop settings."
      />
      <Card>
        <CardHeader title="Customer app" />
        <div className="divide-y divide-zinc-100">
          {APP_SWITCHES.map((k) => (
            <SwitchToggle key={k} k={k} label={APP_SWITCH_LABEL[k]} on={now[k]} lockedOff={killed.includes(k)} />
          ))}
        </div>
      </Card>
      <p className="text-xs text-zinc-500">
        For an outage when this page can&apos;t be reached, set APP_KILL in Vercel (for example <code>booking,payments</code>) and redeploy. To force everyone onto a new app build, raise APP_IOS_MIN_VERSION or APP_ANDROID_MIN_VERSION.
      </p>
    </div>
  );
}
