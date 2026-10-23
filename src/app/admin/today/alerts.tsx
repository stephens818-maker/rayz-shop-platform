"use client";

import Link from "next/link";
import { useState } from "react";
import { Badge, Button, Card, CardHeader, Notice, cx } from "@/components/ui";
import { useAction } from "@/components/use-action";
import { ALERT_LABEL, type Alert, type Severity } from "@/domain/today";
import { dismissAlertAction, runAlertAction } from "./actions";

const TONE: Record<Severity, "red" | "amber" | "gray"> = { high: "red", medium: "amber", low: "gray" };
const BAR: Record<Severity, string> = { high: "border-l-red-500", medium: "border-l-amber-400", low: "border-l-zinc-200" };

function AlertRow({ alert: a, multiShop }: { alert: Alert; multiShop: boolean }) {
  const { pending, error, run } = useAction();
  const [confirming, setConfirming] = useState(false);
  const [done, setDone] = useState<{ message: string; href: string | null } | null>(null);
  const [open, setOpen] = useState(a.severity === "high");
  return (
    <li className={cx("border-l-4 px-4 py-3 text-sm", BAR[a.severity])}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={TONE[a.severity]}>{ALERT_LABEL[a.type]}</Badge>
            {multiShop && a.shop && <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">{a.shop}</span>}
          </div>
          <p className="mt-1 font-medium text-zinc-900">{a.title}</p>
          <p className="text-zinc-600">{a.detail}</p>
          {a.items && a.items.length > 0 && (
            <>
              <button type="button" className="mt-1 text-xs text-zinc-500 underline" onClick={() => setOpen(!open)}>
                {open ? "Hide" : `Show ${a.items.length}`}
              </button>
              {open && (
                <ul className="mt-1 space-y-0.5 text-xs text-zinc-700">
                  {a.items.map((i, n) => (
                    <li key={n}>
                      {i.href ? (
                        <Link className="font-medium underline" href={i.href}>
                          {i.label}
                        </Link>
                      ) : (
                        <span className="font-medium">{i.label}</span>
                      )}
                      {i.sub && <span className="text-zinc-500"> · {i.sub}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {a.action && !done && !confirming && (
            <Button size="sm" disabled={pending} onClick={() => setConfirming(true)}>
              {a.action.label}
            </Button>
          )}
          {a.href && (
            <Link className="text-xs underline" href={a.href}>
              {a.linkLabel ?? "Open"}
            </Link>
          )}
          <Button size="sm" variant="ghost" disabled={pending} title="Hide until tomorrow" onClick={() => run(() => dismissAlertAction(a.key, 1))}>
            Dismiss
          </Button>
        </div>
      </div>
      {confirming && a.action && (
        <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg bg-zinc-50 p-2">
          <span className="flex-1 text-zinc-700">{a.action.confirm}</span>
          <Button
            size="sm"
            disabled={pending}
            onClick={() =>
              run(
                () => runAlertAction(a.key),
                (d) => {
                  setDone(d);
                  setConfirming(false);
                },
              )
            }
          >
            {pending ? "Working…" : "Do it"}
          </Button>
          <Button size="sm" variant="secondary" disabled={pending} onClick={() => setConfirming(false)}>
            Cancel
          </Button>
        </div>
      )}
      {done && (
        <Notice tone="green">
          {done.message}{" "}
          {done.href && (
            <Link className="underline" href={done.href}>
              Open
            </Link>
          )}
        </Notice>
      )}
      {error && <Notice tone="red">{error}</Notice>}
    </li>
  );
}

export function TodayAlerts({ alerts, multiShop }: { alerts: Alert[]; multiShop: boolean }) {
  const high = alerts.filter((a) => a.severity === "high").length;
  return (
    <Card>
      <CardHeader
        title="Needs attention"
        subtitle={alerts.length ? `${alerts.length} item${alerts.length === 1 ? "" : "s"}${high ? `, ${high} urgent` : ""}. Dismissed items come back tomorrow if they still apply.` : undefined}
      />
      {alerts.length === 0 ? (
        <p className="px-4 py-3 text-sm text-zinc-500">Nothing needs you right now.</p>
      ) : (
        <ul className="divide-y divide-zinc-100">
          {alerts.map((a) => (
            <AlertRow key={a.key} alert={a} multiShop={multiShop} />
          ))}
        </ul>
      )}
    </Card>
  );
}
