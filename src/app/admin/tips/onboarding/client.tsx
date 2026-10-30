"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { Badge, Button, Notice, Select, Table, Td, Th } from "@/components/ui";
import { CHANNEL_CHOICE_LABEL, ChannelChoice, ONBOARDING_HINT, ONBOARDING_LABEL, ONBOARDING_TONE, OnboardingProgress, stillToDo } from "@/domain/staff-onboarding";
import type { ActionResult } from "@/server/action";
import type { InviteSkip } from "@/server/tips/onboarding";
import { sendInvitesAction, stopRemindersAction } from "./actions";

export interface TrackerRow {
  staffId: string;
  name: string;
  shops: string;
  progress: OnboardingProgress;
  noContact: boolean;
  contact: string;
  invited: string | null;
  reminders: string | null;
  canStopReminders: boolean;
  waiting: string | null;
  needs: string[];
  stripeDeadline: string | null;
  squireDeadline: string | null;
}

const CHOICES: ChannelChoice[] = ["sms", "email", "both"];

export function OnboardingTracker({ rows }: { rows: TrackerRow[] }) {
  const router = useRouter();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [choice, setChoice] = useState<ChannelChoice>("sms");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ sent: number; skipped: InviteSkip[] } | null>(null);
  const open = useMemo(() => rows.filter((r) => stillToDo(r.progress) && !r.noContact), [rows]);
  const notInvited = useMemo(() => open.filter((r) => r.progress === "not_invited"), [open]);
  const toggle = (id: string) =>
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const run = (fn: () => Promise<ActionResult<unknown>>, after?: (d: unknown) => void) =>
    start(async () => {
      setError(null);
      const r = await fn();
      if (!r.ok) setError(r.error);
      else {
        after?.(r.data);
        router.refresh();
      }
    });
  const send = () =>
    run(
      () => sendInvitesAction({ staffIds: [...picked], choice }),
      (d) => {
        setResult(d as { sent: number; skipped: InviteSkip[] });
        setPicked(new Set());
      },
    );
  const allPicked = rows.length > 0 && rows.every((r) => picked.has(r.staffId));
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 border-b border-zinc-100 px-4 py-3">
        <Button size="sm" variant="secondary" disabled={!open.length} onClick={() => setPicked(new Set(open.map((r) => r.staffId)))}>
          Select everyone not done ({open.length})
        </Button>
        <Button size="sm" variant="secondary" disabled={!notInvited.length} onClick={() => setPicked(new Set(notInvited.map((r) => r.staffId)))}>
          Select not invited ({notInvited.length})
        </Button>
        {picked.size > 0 && (
          <Button size="sm" variant="secondary" onClick={() => setPicked(new Set())}>
            Clear
          </Button>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Select aria-label="Send by" className="w-40 py-1" value={choice} onChange={(e) => setChoice(e.target.value as ChannelChoice)}>
            {CHOICES.map((c) => (
              <option key={c} value={c}>
                {CHANNEL_CHOICE_LABEL[c]}
              </option>
            ))}
          </Select>
          <Button size="sm" disabled={pending || !picked.size} onClick={send}>
            Send onboarding invite{picked.size === 1 ? "" : "s"}
            {picked.size ? ` (${picked.size})` : ""}
          </Button>
        </div>
      </div>
      {(error || result) && (
        <div className="space-y-2 px-4 pt-3">
          {error && <Notice tone="red">{error}</Notice>}
          {result && (
            <Notice tone={result.skipped.length ? "amber" : "green"}>
              Sent {result.sent} invite{result.sent === 1 ? "" : "s"}. Reminders follow until each person is done.
              {result.skipped.length > 0 && (
                <ul className="mt-1 list-disc pl-5">
                  {result.skipped.map((s) => (
                    <li key={s.staffId}>
                      {s.name ?? "Someone"}: {s.why}
                    </li>
                  ))}
                </ul>
              )}
            </Notice>
          )}
        </div>
      )}
      <Table label="Staff payout onboarding">
        <thead>
          <tr>
            <Th>
              <input
                type="checkbox"
                aria-label="Select everyone"
                checked={allPicked}
                onChange={() => setPicked(allPicked ? new Set() : new Set(rows.map((r) => r.staffId)))}
              />
            </Th>
            <Th>Employee</Th>
            <Th>Status</Th>
            <Th>Invited</Th>
            <Th>Reminders</Th>
            <Th right>Tips waiting</Th>
            <Th>Stripe needs</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.staffId} className={picked.has(r.staffId) ? "bg-sky-50/50" : undefined}>
              <Td>
                <input type="checkbox" aria-label={`Select ${r.name}`} checked={picked.has(r.staffId)} onChange={() => toggle(r.staffId)} />
              </Td>
              <Td>
                <div className="font-medium">{r.name}</div>
                <div className="text-xs text-zinc-500">{r.shops}</div>
                <div className={r.noContact ? "text-xs text-red-600" : "text-xs text-zinc-500"}>{r.contact}</div>
              </Td>
              <Td>
                <Badge tone={ONBOARDING_TONE[r.progress]}>{ONBOARDING_LABEL[r.progress]}</Badge>
                <div className="mt-0.5 text-xs text-zinc-500">{ONBOARDING_HINT[r.progress]}</div>
                {r.squireDeadline && stillToDo(r.progress) && <div className="text-xs text-amber-700">Squire tips end {r.squireDeadline}</div>}
              </Td>
              <Td className="text-xs text-zinc-600">{r.invited ?? "—"}</Td>
              <Td className="text-xs text-zinc-600">
                {r.reminders ?? "—"}
                {r.canStopReminders && (
                  <div>
                    <button type="button" className="text-xs text-zinc-500 underline hover:text-zinc-900" disabled={pending} onClick={() => run(() => stopRemindersAction(r.staffId))}>
                      Stop reminders
                    </button>
                  </div>
                )}
              </Td>
              <Td right className={r.waiting ? "font-medium text-amber-700" : "text-zinc-400"}>
                {r.waiting ?? "—"}
              </Td>
              <Td className="text-xs text-zinc-600">
                {r.needs.length ? (
                  <ul className="list-disc pl-4">
                    {r.needs.map((n) => (
                      <li key={n}>{n}</li>
                    ))}
                  </ul>
                ) : (
                  "—"
                )}
                {r.stripeDeadline && <div className="text-red-600">Due {r.stripeDeadline}</div>}
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </div>
  );
}
