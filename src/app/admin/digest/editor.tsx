"use client";

import { useState } from "react";
import { Badge, Button, Card, CardHeader, Field, Notice, Select } from "@/components/ui";
import { useAction } from "@/components/use-action";
import type { DigestSettings } from "@/domain/digest";
import { minutesToLabel } from "@/lib/time";
import { saveDigestAction, sendTestDigestAction } from "./actions";

export interface DigestPerson {
  id: string;
  label: string;
  email: string | null;
  role: string;
  /** Their brand role plus any per-shop roles. */
  roleKeys: string[];
}

const TIMES = Array.from({ length: (11 - 4) * 4 + 1 }, (_, i) => 4 * 60 + i * 15);
const SECTIONS = [
  ["sales", "Yesterday's sales by shop, against the same day the week before"],
  ["staff", "Today's team: who's working, off and blocked at each shop"],
  ["alerts", "What Today flagged: open chairs, low stock, approvals, variances and the rest"],
] as const;

type Mode = "role" | "always" | "never";

export function DigestEditor({ initial, roles, people }: { initial: DigestSettings; roles: { key: string; name: string }[]; people: DigestPerson[] }) {
  const { pending, error, run } = useAction();
  const [s, setS] = useState(initial);
  const [msg, setMsg] = useState<string | null>(null);
  const dirty = JSON.stringify(s) !== JSON.stringify(initial);
  const byRole = (p: DigestPerson) => p.roleKeys.some((k) => s.roles.includes(k));
  const modeOf = (p: DigestPerson): Mode => (s.exclude.includes(p.id) ? "never" : s.include.includes(p.id) ? "always" : "role");
  const gets = (p: DigestPerson) => !!p.email && modeOf(p) !== "never" && (modeOf(p) === "always" || byRole(p));
  const setMode = (id: string, m: Mode) =>
    setS((x) => ({ ...x, include: m === "always" ? [...new Set([...x.include, id])] : x.include.filter((i) => i !== id), exclude: m === "never" ? [...new Set([...x.exclude, id])] : x.exclude.filter((i) => i !== id) }));
  const toggleRole = (key: string) => setS((x) => ({ ...x, roles: x.roles.includes(key) ? x.roles.filter((r) => r !== key) : [...x.roles, key] }));
  const count = people.filter(gets).length;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title="Schedule" subtitle="Goes out by email each morning; each person sees only their own shops and what their permissions allow." />
        <div className="grid gap-4 p-4 sm:grid-cols-2">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={s.enabled} onChange={(e) => setS({ ...s, enabled: e.target.checked })} /> Send the morning digest
          </label>
          <Field label="Send at (shop time)" hint="Within five minutes of this time. Nothing goes out after noon, so a late deploy doesn't send a stale one.">
            <Select value={s.sendAtMin} onChange={(e) => setS({ ...s, sendAtMin: Number(e.target.value) })}>
              {TIMES.map((t) => (
                <option key={t} value={t}>
                  {minutesToLabel(t)}
                </option>
              ))}
            </Select>
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={s.skipClosedDays} onChange={(e) => setS({ ...s, skipClosedDays: e.target.checked })} /> Skip days every shop is closed
          </label>
        </div>
      </Card>

      <Card>
        <CardHeader title="What's in it" />
        <div className="space-y-2 p-4">
          {SECTIONS.map(([k, label]) => (
            <label key={k} className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={s.sections[k]} onChange={(e) => setS({ ...s, sections: { ...s.sections, [k]: e.target.checked } })} /> {label}
            </label>
          ))}
        </div>
      </Card>

      <Card>
        <CardHeader title="Who gets it" subtitle={`${count} ${count === 1 ? "person" : "people"} with these settings. A role counts whether it's someone's main role or their role at one shop.`} />
        <div className="flex flex-wrap gap-x-5 gap-y-2 border-b border-zinc-100 p-4">
          {roles.map((r) => (
            <label key={r.key} className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={s.roles.includes(r.key)} onChange={() => toggleRole(r.key)} /> {r.name}
            </label>
          ))}
        </div>
        <ul className="divide-y divide-zinc-100">
          {people.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center gap-3 px-4 py-2 text-sm">
              <span className="min-w-40 font-medium text-zinc-900">{p.label}</span>
              <span className="text-zinc-500">{p.role}</span>
              {!p.email ? <Badge>No email</Badge> : gets(p) ? <Badge tone="green">Gets it</Badge> : <Badge>Doesn&apos;t</Badge>}
              <Select className="ml-auto w-auto" value={modeOf(p)} onChange={(e) => setMode(p.id, e.target.value as Mode)} aria-label={`Digest for ${p.label}`}>
                <option value="role">By role{byRole(p) ? " (yes)" : " (no)"}</option>
                <option value="always">Always</option>
                <option value="never">Never</option>
              </Select>
            </li>
          ))}
        </ul>
      </Card>

      {error && <Notice tone="red">{error}</Notice>}
      {msg && <Notice tone="green">{msg}</Notice>}
      <div className="flex flex-wrap gap-3">
        <Button disabled={pending || !dirty} onClick={() => run(() => saveDigestAction(s), () => setMsg("Saved. Tomorrow's digest uses these settings."))}>
          Save
        </Button>
        <Button variant="secondary" disabled={pending} onClick={() => run(() => sendTestDigestAction(), (r) => setMsg(`Sent your digest to ${r.to}.`))}>
          Email me a test
        </Button>
      </div>
    </div>
  );
}
