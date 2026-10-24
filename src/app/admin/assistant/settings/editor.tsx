"use client";

import { useState } from "react";
import { Button, Card, CardHeader, Field, Input } from "@/components/ui";
import { useAction } from "@/components/use-action";
import type { AssistantSettings } from "@/domain/assistant";
import { saveAssistantSettingsAction } from "../actions";

export function AssistantSettingsEditor({ initial, roles }: { initial: AssistantSettings; roles: { id: string; name: string; key: string | null }[] }) {
  const { pending, error, run } = useAction();
  const [s, setS] = useState(initial);
  const [saved, setSaved] = useState(false);
  const dirty = JSON.stringify(s) !== JSON.stringify(initial);
  const setRole = (id: string, on: boolean) =>
    setS((x) => {
      const next = { ...x.roles };
      if (on) delete next[id];
      else next[id] = false;
      return { ...x, roles: next };
    });
  return (
    <Card>
      <CardHeader title="Who gets it" subtitle="People see the assistant when it's on for the role they're working under. New roles start with it on." />
      <div className="space-y-4 px-4 py-3">
        <label className="flex items-center gap-2 text-sm font-medium text-zinc-900">
          <input type="checkbox" checked={s.enabled} onChange={(e) => setS({ ...s, enabled: e.target.checked })} data-testid="assistant-enabled" />
          Rayz Assistant is on
        </label>
        <fieldset disabled={!s.enabled} className="space-y-1 disabled:opacity-50">
          <legend className="mb-1 text-xs font-medium tracking-wide text-zinc-500 uppercase">Roles</legend>
          {roles.map((r) => (
            <label key={r.id} className="flex items-center gap-2 text-sm text-zinc-700">
              <input type="checkbox" checked={s.roles[r.id] !== false} onChange={(e) => setRole(r.id, e.target.checked)} />
              {r.name}
              {!r.key && <span className="text-xs text-zinc-400">custom role</span>}
            </label>
          ))}
        </fieldset>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Questions per person per minute">
            <Input type="number" min={1} max={30} value={s.perMinute} onChange={(e) => setS({ ...s, perMinute: Number(e.target.value) })} />
          </Field>
          <Field label="Questions per person per day">
            <Input type="number" min={5} max={1000} value={s.perDay} onChange={(e) => setS({ ...s, perDay: Number(e.target.value) })} />
          </Field>
        </div>
        <label className="flex items-start gap-2 text-sm text-zinc-700">
          <input type="checkbox" className="mt-1" checked={s.actions} onChange={(e) => setS({ ...s, actions: e.target.checked })} />
          <span>
            May draft blasts and purchase orders
            <span className="block text-xs text-zinc-500">Only for people who could make them themselves, and nothing is created until they press Confirm. A confirmed blast is saved as a draft; it never sends.</span>
          </span>
        </label>
        {error && <p className="text-sm text-red-700">{error}</p>}
        {saved && !dirty && <p className="text-sm text-emerald-700">Saved.</p>}
        <Button disabled={pending || !dirty} onClick={() => run(() => saveAssistantSettingsAction(s), () => setSaved(true))}>
          Save
        </Button>
      </div>
    </Card>
  );
}
