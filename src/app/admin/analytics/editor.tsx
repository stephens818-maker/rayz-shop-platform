"use client";

import { useState } from "react";
import { Button, Card, CardHeader } from "@/components/ui";
import { useAction } from "@/components/use-action";
import { runBackfillAction, saveAnalyticsSettingsAction } from "./actions";

export function AnalyticsSettingsEditor({
  initial,
  warehouseAddress,
}: {
  initial: { satisfaction: boolean; warehouse: boolean };
  warehouseAddress: boolean;
}) {
  const { pending, error, run } = useAction();
  const [s, setS] = useState(initial);
  const [saved, setSaved] = useState(false);
  const dirty =
    s.satisfaction !== initial.satisfaction ||
    s.warehouse !== initial.warehouse;
  return (
    <Card>
      <CardHeader title="Settings" />
      <div className="space-y-3 px-4 py-3">
        <label className="flex items-start gap-2 text-sm text-zinc-700">
          <input
            type="checkbox"
            className="mt-1"
            checked={s.satisfaction}
            onChange={(e) => setS({ ...s, satisfaction: e.target.checked })}
            data-testid="analytics-satisfaction"
          />
          <span>
            Ask &quot;How was your visit?&quot; on receipts
            <span className="block text-xs text-zinc-500">
              One to five stars, once per paid ticket. Answers go in the event
              log and the Operations KPIs report, by location and barber.
            </span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-sm text-zinc-700">
          <input
            type="checkbox"
            className="mt-1"
            checked={s.warehouse}
            onChange={(e) => setS({ ...s, warehouse: e.target.checked })}
          />
          <span>
            Copy new events to the warehouse every night
            <span className="block text-xs text-zinc-500">
              {warehouseAddress
                ? "Into the rayz_analytics_events table at the warehouse address set on the server. Client merges and erasures are applied there too."
                : "Set ANALYTICS_WAREHOUSE_URL on the server first (a Postgres database or replica your BI tool or BigQuery reads from). The address is never stored in the app."}
            </span>
          </span>
        </label>
        {error && <p className="text-sm text-red-700">{error}</p>}
        {saved && !dirty && <p className="text-sm text-emerald-700">Saved.</p>}
        <Button
          disabled={pending || !dirty}
          onClick={() =>
            run(
              () => saveAnalyticsSettingsAction(s),
              () => setSaved(true),
            )
          }
        >
          Save
        </Button>
      </div>
    </Card>
  );
}

export function BackfillButton() {
  const { pending, error, run } = useAction();
  const [done, setDone] = useState<string | null>(null);
  return (
    <div className="space-y-1">
      <Button
        size="sm"
        variant="secondary"
        disabled={pending}
        onClick={() =>
          run(
            () => runBackfillAction(),
            (r) => {
              const n = Object.values(r.done).reduce((a, b) => a + b, 0);
              setDone(
                `${n.toLocaleString("en-US")} events logged${r.remaining.length ? `; ${r.remaining.length} tables left for the next run` : ""}.`,
              );
            },
          )
        }
      >
        {pending ? "Logging history…" : "Log history now"}
      </Button>
      {error && <p className="text-sm text-red-700">{error}</p>}
      {done && <p className="text-xs text-emerald-700">{done}</p>}
    </div>
  );
}
