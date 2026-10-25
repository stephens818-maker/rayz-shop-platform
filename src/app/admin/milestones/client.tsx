"use client";

import { useState } from "react";
import { Button, Field, Input, Select } from "@/components/ui";
import { useAction } from "@/components/use-action";
import { MONTHS } from "@/domain/milestones";
import { cheerAction, dismissCongratsAction, saveMyMilestonePrefsAction, uncheerAction } from "./actions";

export function DismissCongrats({ ids, label = "Thanks!" }: { ids: string[]; label?: string }) {
  const { pending, error, run } = useAction();
  return (
    <span className="inline-flex items-center gap-2">
      <Button size="sm" variant="secondary" disabled={pending} onClick={() => run(() => dismissCongratsAction(ids))}>
        {label}
      </Button>
      {error && <span className="text-xs text-red-600">{error}</span>}
    </span>
  );
}

export function CheerButton({ milestoneId, cheered, count }: { milestoneId: string; cheered: boolean; count: number }) {
  const { pending, error, run } = useAction();
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  if (cheered)
    return (
      <span className="inline-flex items-center gap-2">
        <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => uncheerAction(milestoneId))} title="Take back your cheer">
          Cheered{count > 1 ? ` · ${count}` : ""}
        </Button>
        {error && <span className="text-xs text-red-600">{error}</span>}
      </span>
    );
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      {open ? (
        <>
          <Input className="h-8 w-56 text-xs" maxLength={140} placeholder="Add a note (optional)" value={message} onChange={(e) => setMessage(e.target.value)} aria-label="Cheer note" />
          <Button size="sm" disabled={pending} onClick={() => run(() => cheerAction(milestoneId, message.trim() || null), () => setOpen(false))}>
            Send cheer
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
        </>
      ) : (
        <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
          Cheer{count ? ` · ${count}` : ""}
        </Button>
      )}
      {error && <span className="text-xs text-red-600">{error}</span>}
    </span>
  );
}

export function MyMilestonePrefs(p: { birthdays: boolean; birthday: { month: number; day: number } | null; shared: boolean; teamFeed: boolean; celebrate: boolean }) {
  const { pending, error, run } = useAction();
  const [month, setMonth] = useState(p.birthday?.month ?? 0);
  const [day, setDay] = useState(p.birthday?.day ?? 0);
  const [shared, setShared] = useState(p.shared);
  const [saved, setSaved] = useState(false);
  const save = () =>
    run(
      () => saveMyMilestonePrefsAction({ shared, ...(p.birthdays ? { birthday: month && day ? { month, day } : null } : {}) }),
      () => setSaved(true),
    );
  const sharedText = [p.teamFeed ? "show in the team feed for teammates to cheer" : null, p.celebrate ? "let the shop celebrate with my clients (first name only)" : null].filter(Boolean).join(", and ");
  return (
    <div className="space-y-3 p-4 text-sm">
      {p.birthdays && (
        <div className="flex flex-wrap items-end gap-2">
          <Field label="My birthday" hint="Month and day only, never the year. Leave blank to keep it private.">
            <div className="flex gap-2">
              <Select
                aria-label="Birthday month"
                value={month}
                onChange={(e) => {
                  setMonth(Number(e.target.value));
                  setSaved(false);
                }}
              >
                <option value={0}>Month</option>
                {MONTHS.map((m, i) => (
                  <option key={m} value={i + 1}>
                    {m}
                  </option>
                ))}
              </Select>
              <Select
                aria-label="Birthday day"
                value={day}
                onChange={(e) => {
                  setDay(Number(e.target.value));
                  setSaved(false);
                }}
              >
                <option value={0}>Day</option>
                {Array.from({ length: 31 }, (_, i) => (
                  <option key={i} value={i + 1}>
                    {i + 1}
                  </option>
                ))}
              </Select>
            </div>
          </Field>
        </div>
      )}
      {sharedText && (
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={shared}
            onChange={(e) => {
              setShared(e.target.checked);
              setSaved(false);
            }}
          />
          <span>
            Share my milestones
            <span className="block text-xs text-zinc-500">When on, my milestones {sharedText}. My managers always see them; sales amounts never leave the managers&rsquo; view.</span>
          </span>
        </label>
      )}
      <div className="flex items-center gap-3">
        <Button size="sm" disabled={pending} onClick={save}>
          Save
        </Button>
        {saved && !error && <span className="text-sm text-emerald-700">Saved</span>}
        {error && <span className="text-sm text-red-600">{error}</span>}
      </div>
    </div>
  );
}
