"use client";

import { useState } from "react";
import { Badge, Button, Card, CardHeader, Field, Input, Notice, Select } from "@/components/ui";
import { useAction } from "@/components/use-action";
import { MORNING_SECTIONS, type MorningSettings, SECTION_HINT, SECTION_LABEL, type VersionKind, versionPlans } from "@/domain/morning-dashboard";
import { saveMorningSettingsAction, sendTestMorningAction } from "./actions";

export interface MorningPerson {
  id: string;
  label: string;
  email: string | null;
  hasPhone: boolean;
  role: string;
  /** Their brand role plus any per-shop roles. */
  roleKeys: string[];
  /** Shops where they may see the Morning Dashboard. */
  shops: { id: string; name: string }[];
}

type Mode = "role" | "always" | "never";

const KIND_LABEL: Record<VersionKind, string> = { combined: "All locations in one email", per_shop: "One email per shop", both: "Both" };

const toTime = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const fromTime = (s: string) => {
  const [h, m] = s.split(":").map(Number);
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null;
};

export function MorningEditor({ initial, roles, people, lastSent }: { initial: MorningSettings; roles: { key: string; name: string }[]; people: MorningPerson[]; lastSent: string }) {
  const { pending, error, run } = useAction();
  const [s, setS] = useState(initial);
  const [msg, setMsg] = useState<string | null>(null);
  const [everyone, setEveryone] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const dirty = JSON.stringify(s) !== JSON.stringify(initial);

  const byRole = (p: MorningPerson) => p.roleKeys.some((k) => s.roles.includes(k));
  const modeOf = (p: MorningPerson): Mode => (s.exclude.includes(p.id) ? "never" : s.include.includes(p.id) ? "always" : "role");
  const listed = (p: MorningPerson) => modeOf(p) === "always" || (modeOf(p) === "role" && byRole(p));
  const plansOf = (p: MorningPerson) =>
    versionPlans(
      p.shops.map((x) => x.id),
      s.versions[p.id],
    );
  const gets = (p: MorningPerson) => !!p.email && listed(p) && plansOf(p).length > 0;
  const setMode = (id: string, m: Mode) =>
    setS((x) => ({
      ...x,
      include: m === "always" ? [...new Set([...x.include, id])] : x.include.filter((i) => i !== id),
      exclude: m === "never" ? [...new Set([...x.exclude, id])] : x.exclude.filter((i) => i !== id),
    }));
  const setVersion = (id: string, v: { kind?: VersionKind; shopIds?: string[] }) =>
    setS((x) => {
      const cur = x.versions[id] ?? { kind: "combined" as const, shopIds: [] };
      const next = { ...cur, ...v };
      const versions = { ...x.versions };
      if (next.kind === "combined" && !next.shopIds.length) delete versions[id];
      else versions[id] = next;
      return { ...x, versions };
    });
  const toggleRole = (key: string) => setS((x) => ({ ...x, roles: x.roles.includes(key) ? x.roles.filter((r) => r !== key) : [...x.roles, key] }));
  const recipients = people.filter(gets);
  const emails = recipients.reduce((a, p) => a + plansOf(p).length, 0);
  const shown = everyone ? people : people.filter((p) => listed(p) || modeOf(p) !== "role");
  const nameOf = (p: MorningPerson, scope: string) => (scope === "all" ? "All locations" : (p.shops.find((x) => x.id === scope)?.name ?? "A shop"));

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title="Schedule" subtitle={lastSent} />
        <div className="grid gap-4 p-4 sm:grid-cols-2">
          <label className="flex items-center gap-2 text-sm sm:col-span-2">
            <input type="checkbox" checked={s.enabled} onChange={(e) => setS({ ...s, enabled: e.target.checked })} /> Send the Morning Dashboard email
          </label>
          <Field label="Send at (Central time)" hint="Any minute from 4:00 to 11:00 AM. If the job is down at that time it catches up until noon, then skips the day.">
            <Input
              type="time"
              step={60}
              min="04:00"
              max="11:00"
              value={toTime(s.sendAtMin)}
              onChange={(e) => {
                const m = fromTime(e.target.value);
                if (m !== null) setS({ ...s, sendAtMin: m });
              }}
            />
          </Field>
          <div className="space-y-2 text-sm">
            <label className="flex items-start gap-2">
              <input type="checkbox" className="mt-1" checked={s.skipClosedDays} onChange={(e) => setS({ ...s, skipClosedDays: e.target.checked })} />
              <span>No email on days every shop is closed (Sundays)</span>
            </label>
            <label className="flex items-start gap-2">
              <input type="checkbox" className="mt-1" checked={s.coverLastOpenDay} onChange={(e) => setS({ ...s, coverLastOpenDay: e.target.checked })} />
              <span>Cover the last day the shops were open, so Monday&apos;s covers Saturday</span>
            </label>
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader title="What's in it" subtitle="Each section shows only the shops where the person can see the matching report. The open dashboard in the app always has every section they can see." />
        <div className="grid gap-x-6 gap-y-3 p-4 sm:grid-cols-2">
          {MORNING_SECTIONS.map((k) => (
            <label key={k} className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-1" checked={s.sections[k]} onChange={(e) => setS({ ...s, sections: { ...s.sections, [k]: e.target.checked } })} />
              <span>
                <span className="font-medium text-zinc-900">{SECTION_LABEL[k]}</span>
                <span className="block text-xs text-zinc-500">{SECTION_HINT[k]}</span>
              </span>
            </label>
          ))}
        </div>
        <div className="space-y-2 border-t border-zinc-100 p-4 text-sm">
          <label className="flex items-start gap-2">
            <input type="checkbox" className="mt-1" checked={s.pdf} onChange={(e) => setS({ ...s, pdf: e.target.checked })} />
            <span>
              Attach a PDF <span className="block text-xs text-zinc-500">The whole dashboard, every barber included, to print or forward.</span>
            </span>
          </label>
          <label className="flex items-start gap-2">
            <input type="checkbox" className="mt-1" checked={s.sms} onChange={(e) => setS({ ...s, sms: e.target.checked })} />
            <span>
              Also text a one-line summary{" "}
              <span className="block text-xs text-zinc-500">Net sales, tickets, today&apos;s open time and what needs attention, with a link. One text a day to each recipient with a mobile number.</span>
            </span>
          </label>
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Who gets it"
          subtitle={`${recipients.length} ${recipients.length === 1 ? "person" : "people"}, ${emails} ${emails === 1 ? "email" : "emails"} a morning. A role counts whether it's someone's main role or their role at one shop. People who can't see the Morning Dashboard report at any shop get nothing.`}
        />
        <div className="flex flex-wrap gap-x-5 gap-y-2 border-b border-zinc-100 p-4">
          {roles.map((r) => (
            <label key={r.key} className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={s.roles.includes(r.key)} onChange={() => toggleRole(r.key)} /> {r.name}
            </label>
          ))}
        </div>
        <ul className="divide-y divide-zinc-100">
          {shown.map((p) => {
            const plans = plansOf(p);
            const v = s.versions[p.id] ?? { kind: "combined" as const, shopIds: [] };
            return (
              <li key={p.id} className="px-4 py-2 text-sm">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="min-w-40 font-medium text-zinc-900">{p.label}</span>
                  <span className="text-zinc-500">{p.role}</span>
                  {!p.email ? (
                    <Badge>No email</Badge>
                  ) : !p.shops.length ? (
                    <Badge>Can&apos;t see the report</Badge>
                  ) : gets(p) ? (
                    <Badge tone="green">{plans.map((x) => nameOf(p, x.scope)).join(" + ")}</Badge>
                  ) : (
                    <Badge>Doesn&apos;t get it</Badge>
                  )}
                  {gets(p) && s.sms && p.hasPhone && <Badge tone="blue">Text</Badge>}
                  <span className="ml-auto flex items-center gap-2">
                    {p.shops.length > 1 && listed(p) && (
                      <button type="button" className="text-xs text-zinc-600 underline" onClick={() => setOpen(open === p.id ? null : p.id)}>
                        Versions
                      </button>
                    )}
                    <Select className="w-auto" value={modeOf(p)} onChange={(e) => setMode(p.id, e.target.value as Mode)} aria-label={`Morning Dashboard for ${p.label}`}>
                      <option value="role">By role{byRole(p) ? " (yes)" : " (no)"}</option>
                      <option value="always">Always</option>
                      <option value="never">Never</option>
                    </Select>
                  </span>
                </div>
                {open === p.id && (
                  <div className="mt-2 grid gap-3 rounded-lg bg-zinc-50 p-3 sm:grid-cols-2">
                    <Field label="Emails">
                      <Select value={v.kind} onChange={(e) => setVersion(p.id, { kind: e.target.value as VersionKind })}>
                        {(Object.keys(KIND_LABEL) as VersionKind[]).map((k) => (
                          <option key={k} value={k}>
                            {KIND_LABEL[k]}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <fieldset className="text-sm">
                      <legend className="text-xs font-medium text-zinc-700">Shops it covers</legend>
                      {p.shops.map((x) => (
                        <label key={x.id} className="mt-1 flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={!v.shopIds.length || v.shopIds.includes(x.id)}
                            onChange={(e) => {
                              const cur = v.shopIds.length ? v.shopIds : p.shops.map((y) => y.id);
                              const next = e.target.checked ? [...cur, x.id] : cur.filter((id) => id !== x.id);
                              setVersion(p.id, { shopIds: next.length === p.shops.length ? [] : next });
                            }}
                          />
                          {x.name}
                        </label>
                      ))}
                    </fieldset>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
        {people.length > shown.length || everyone ? (
          <div className="border-t border-zinc-100 px-4 py-2">
            <button type="button" className="text-xs text-zinc-600 underline" onClick={() => setEveryone(!everyone)}>
              {everyone ? "Show only who gets it" : `Add someone else (${people.length - shown.length} more people)`}
            </button>
          </div>
        ) : null}
      </Card>

      {error && <Notice tone="red">{error}</Notice>}
      {msg && <Notice tone="green">{msg}</Notice>}
      <div className="flex flex-wrap gap-3">
        <Button disabled={pending || !dirty} onClick={() => run(() => saveMorningSettingsAction(s), () => setMsg("Saved. The next Morning Dashboard uses these settings."))}>
          Save
        </Button>
        <Button
          variant="secondary"
          disabled={pending}
          onClick={() => run(() => sendTestMorningAction(), (r) => setMsg(`Sent ${r.versions === 1 ? "your Morning Dashboard" : `your ${r.versions} Morning Dashboard emails`} to ${r.to}, with the saved settings.`))}
        >
          Email me a test
        </Button>
      </div>
    </div>
  );
}
