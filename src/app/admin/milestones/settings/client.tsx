"use client";

import { useState } from "react";
import { Badge, Button, Field, Input, Select } from "@/components/ui";
import { useAction } from "@/components/use-action";
import {
  COUNT_METRICS,
  CUSTOM_KINDS,
  KIND_LABEL,
  METRICS,
  type MilestoneKind,
  type MilestoneSettings,
  metricsOf,
  parseThresholds,
} from "@/domain/milestones";
import {
  checkMilestonesNowAction,
  deleteBaselineAction,
  deleteMilestoneRuleAction,
  saveBaselineAction,
  saveMilestoneRuleAction,
  saveMilestoneSettingsAction,
} from "./actions";

type Option = { id: string; name: string };

const TOGGLES: { key: keyof MilestoneSettings; label: string; hint: string }[] =
  [
    {
      key: "enabled",
      label: "Track staff milestones",
      hint: "Counts, anniversaries, personal bests and streaks, checked every hour.",
    },
    {
      key: "alertBrand",
      label: "Email the brand",
      hint: "People who see every shop get an email when someone reaches one.",
    },
    {
      key: "alertManagers",
      label: "Email their managers",
      hint: "Managers of the shops the person works at get the same email.",
    },
    {
      key: "congratulate",
      label: "Congratulate them in their portal",
      hint: "A notice on their Today page and Milestones page until they dismiss it.",
    },
    {
      key: "teamFeed",
      label: "Team shout-out feed",
      hint: "Teammates at the same shops see each other's new milestones and can cheer them. Each person can opt out; sales amounts are never shown.",
    },
    {
      key: "celebrate",
      label: "Let clients celebrate with their barber",
      hint: "Managers can start a blast from the approved milestone template: the barber's first name and the milestone, to their recent clients. Only cuts, clients and anniversaries, never money.",
    },
    {
      key: "birthdays",
      label: "Birthdays",
      hint: "Staff may add their birthday (month and day only) and it shows in Coming up. Never in reports.",
    },
  ];

/** What shows in the software on the day, by first name. Never money or ratings, and never for someone who turned sharing off. */
const ON_THE_DAY: {
  key: keyof MilestoneSettings;
  label: string;
  hint: string;
}[] = [
  {
    key: "calendarBanner",
    label: "Banner on the calendar",
    hint: "“Today is Jamie's 1,000th cut!” across the top of the shop's calendar for the day.",
  },
  {
    key: "posBanner",
    label: "Banner on Sales & checkout",
    hint: "The same banner on Sales and on the checkout screen.",
  },
  {
    key: "columnBadge",
    label: "Confetti on their calendar column",
    hint: "A confetti badge next to their name on the calendar for the day.",
  },
  {
    key: "welcomeModal",
    label: "Congratulations when they clock in or open their portal",
    hint: "A window on clocking in (phone or front-desk clock) and on their Today page, until they've seen it. The front-desk clock leaves sales amounts out.",
  },
  {
    key: "liveToast",
    label: "Live toast for the shop",
    hint: "When a count is reached during the day, like a 1,000th cut at checkout, everyone signed in at the shop gets a toast.",
  },
  {
    key: "allLocations",
    label: "Show at other locations too",
    hint: "Off: banners and toasts show only at the shops the person works at. On: at every location.",
  },
];

export function MilestoneSettingsForm({
  initial,
}: {
  initial: MilestoneSettings;
}) {
  const { pending, error, run } = useAction();
  const [s, setS] = useState(initial);
  const [saved, setSaved] = useState(false);
  const set = (patch: Partial<MilestoneSettings>) => {
    setS({ ...s, ...patch });
    setSaved(false);
  };
  const toggle = (t: (typeof TOGGLES)[number]) => (
    <label key={t.key} className="flex items-start gap-2">
      <input
        type="checkbox"
        className="mt-0.5"
        checked={!!s[t.key]}
        disabled={t.key !== "enabled" && !s.enabled}
        onChange={(e) => set({ [t.key]: e.target.checked })}
      />
      <span>
        {t.label}
        <span className="block text-xs text-zinc-500">{t.hint}</span>
      </span>
    </label>
  );
  return (
    <div className="space-y-3 p-4 text-sm">
      {TOGGLES.map(toggle)}
      <fieldset
        className="space-y-3 border-t border-zinc-100 pt-3"
        data-testid="on-the-day"
      >
        <legend className="pt-3 text-xs font-semibold uppercase tracking-wide text-zinc-500">
          On the day
        </legend>
        {ON_THE_DAY.map(toggle)}
      </fieldset>
      <Field
        label="Coming up looks ahead"
        hint="Days, on the Milestones page and the Morning Dashboard."
      >
        <Input
          type="number"
          className="w-24"
          min={1}
          max={31}
          value={s.upcomingDays}
          onChange={(e) => set({ upcomingDays: Number(e.target.value) })}
        />
      </Field>
      <div className="flex items-center gap-3">
        <Button
          size="sm"
          disabled={pending}
          onClick={() =>
            run(
              () => saveMilestoneSettingsAction(s),
              () => setSaved(true),
            )
          }
        >
          Save
        </Button>
        {saved && !error && <span className="text-emerald-700">Saved</span>}
        {error && <span className="text-red-600">{error}</span>}
      </div>
    </div>
  );
}

export interface RuleRow {
  id: string | null;
  kind: MilestoneKind;
  metric: string;
  name: string;
  unit: string | null;
  thresholds: number[];
  serviceIds: string[];
  active: boolean;
  builtIn: boolean;
}

const hasNumbers = (k: MilestoneKind) =>
  k === "count" || k === "anniversary" || k === "streak";

export function RuleEditor({
  rule,
  services,
  onDone,
}: {
  rule: RuleRow;
  services: Option[];
  onDone?: () => void;
}) {
  const { pending, error, setError, run } = useAction();
  const [r, setR] = useState(rule);
  const [numbers, setNumbers] = useState(rule.thresholds.join(", "));
  const isNew = !rule.id;
  const save = () => {
    const thresholds = hasNumbers(r.kind) ? parseThresholds(numbers) : [];
    if (!thresholds) return setError("Use whole numbers, separated by commas");
    run(
      () => saveMilestoneRuleAction({ ...r, unit: r.unit ?? "", thresholds }),
      () => onDone?.(),
    );
  };
  return (
    <div className="space-y-3 rounded-lg bg-zinc-50 p-3 text-sm ring-1 ring-inset ring-zinc-200">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name">
          <Input
            value={r.name}
            maxLength={60}
            onChange={(e) => setR({ ...r, name: e.target.value })}
          />
        </Field>
        {isNew ? (
          <Field label="Kind">
            <Select
              value={r.kind}
              onChange={(e) => {
                const kind = e.target.value as MilestoneKind;
                setR({
                  ...r,
                  kind,
                  metric: metricsOf(kind)[0],
                  serviceIds: [],
                });
              }}
            >
              {CUSTOM_KINDS.map((k) => (
                <option key={k} value={k}>
                  {KIND_LABEL[k]}
                </option>
              ))}
            </Select>
          </Field>
        ) : (
          <Field label="Counts">
            <div className="py-2 text-zinc-700">
              {METRICS[r.metric as keyof typeof METRICS]?.label ?? r.metric}
            </div>
          </Field>
        )}
        {isNew && metricsOf(r.kind).length > 1 && (
          <Field
            label="Counts"
            hint={METRICS[r.metric as keyof typeof METRICS]?.hint}
          >
            <Select
              value={r.metric}
              onChange={(e) =>
                setR({ ...r, metric: e.target.value, serviceIds: [] })
              }
            >
              {metricsOf(r.kind).map((m) => (
                <option key={m} value={m}>
                  {METRICS[m].label}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {hasNumbers(r.kind) && (
          <Field
            label={r.kind === "anniversary" ? "Years" : "Numbers to reach"}
            hint="Separated by commas"
          >
            <Input
              value={numbers}
              onChange={(e) => setNumbers(e.target.value)}
              placeholder={
                r.kind === "anniversary" ? "1, 5, 10" : "100, 500, 1000"
              }
            />
          </Field>
        )}
        {(r.kind === "count" || r.kind === "streak") && (
          <Field
            label="Called"
            hint={`How it reads: "1,000 ${r.unit || METRICS[r.metric as keyof typeof METRICS]?.unit || "times"}"`}
          >
            <Input
              value={r.unit ?? ""}
              maxLength={40}
              placeholder={METRICS[r.metric as keyof typeof METRICS]?.unit}
              onChange={(e) => setR({ ...r, unit: e.target.value })}
            />
          </Field>
        )}
      </div>
      {r.metric === "services" && !r.builtIn && (
        <Field
          label="Only these services"
          hint="Leave all unticked to count every service. Squire totals don't apply to a service-limited count."
        >
          <div className="flex max-h-40 flex-wrap gap-x-4 gap-y-1 overflow-y-auto">
            {services.map((s) => (
              <label key={s.id} className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={r.serviceIds.includes(s.id)}
                  onChange={(e) =>
                    setR({
                      ...r,
                      serviceIds: e.target.checked
                        ? [...r.serviceIds, s.id]
                        : r.serviceIds.filter((x) => x !== s.id),
                    })
                  }
                />
                {s.name}
              </label>
            ))}
          </div>
        </Field>
      )}
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={r.active}
          onChange={(e) => setR({ ...r, active: e.target.checked })}
        />
        On
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={pending} onClick={save}>
          {isNew ? "Add milestone" : "Save"}
        </Button>
        {onDone && (
          <Button size="sm" variant="ghost" onClick={onDone}>
            Cancel
          </Button>
        )}
        {!isNew && !r.builtIn && (
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto text-red-600"
            disabled={pending}
            onClick={() => {
              if (
                confirm(
                  `Remove "${rule.name}"? Milestones already reached stay in the history.`,
                )
              )
                run(
                  () => deleteMilestoneRuleAction(rule.id!),
                  () => onDone?.(),
                );
            }}
          >
            Remove
          </Button>
        )}
        {error && <span className="text-red-600">{error}</span>}
      </div>
    </div>
  );
}

export function RuleRowView({
  rule,
  services,
  summary,
}: {
  rule: RuleRow;
  services: Option[];
  summary: string;
}) {
  const [editing, setEditing] = useState(false);
  if (editing)
    return (
      <RuleEditor
        rule={rule}
        services={services}
        onDone={() => setEditing(false)}
      />
    );
  return (
    <div className="flex flex-wrap items-center gap-3 text-sm">
      <div className="min-w-0 flex-1">
        <div className="font-medium text-zinc-900">
          {rule.name} {!rule.active && <Badge>Off</Badge>}{" "}
          {!rule.builtIn && <Badge tone="violet">Custom</Badge>}
        </div>
        <div className="text-xs text-zinc-500">{summary}</div>
      </div>
      <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
        Edit
      </Button>
    </div>
  );
}

export function NewRule({ services }: { services: Option[] }) {
  const [open, setOpen] = useState(false);
  if (!open)
    return (
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
        Add your own
      </Button>
    );
  return (
    <RuleEditor
      rule={{
        id: null,
        kind: "count",
        metric: "services",
        name: "",
        unit: "",
        thresholds: [],
        serviceIds: [],
        active: true,
        builtIn: false,
      }}
      services={services}
      onDone={() => setOpen(false)}
    />
  );
}

export function BaselineForm({
  people,
  today,
}: {
  people: Option[];
  today: string;
}) {
  const { pending, error, run } = useAction();
  const [staffId, setStaffId] = useState(people[0]?.id ?? "");
  const [metric, setMetric] = useState<string>("services");
  const [count, setCount] = useState("");
  const [asOf, setAsOf] = useState(today);
  return (
    <div className="flex flex-wrap items-end gap-2 text-sm">
      <Field label="Person">
        <Select value={staffId} onChange={(e) => setStaffId(e.target.value)}>
          {people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Total of">
        <Select value={metric} onChange={(e) => setMetric(e.target.value)}>
          {COUNT_METRICS.map((m) => (
            <option key={m} value={m}>
              {METRICS[m].label}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Total">
        <Input
          type="number"
          min={0}
          className="w-28"
          value={count}
          onChange={(e) => setCount(e.target.value)}
        />
      </Field>
      <Field label="Before">
        <Input
          type="date"
          max={today}
          value={asOf}
          onChange={(e) => setAsOf(e.target.value)}
        />
      </Field>
      <Button
        size="sm"
        disabled={pending || !staffId || count === ""}
        onClick={() =>
          run(
            () =>
              saveBaselineAction({
                staffId,
                metric,
                count: Number(count),
                asOf,
              }),
            () => setCount(""),
          )
        }
      >
        Save total
      </Button>
      {error && <span className="text-red-600">{error}</span>}
    </div>
  );
}

export function RemoveBaseline({
  staffId,
  metric,
}: {
  staffId: string;
  metric: string;
}) {
  const { pending, error, run } = useAction();
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        disabled={pending}
        onClick={() => run(() => deleteBaselineAction(staffId, metric))}
      >
        Remove
      </Button>
      {error && <span className="text-xs text-red-600">{error}</span>}
    </>
  );
}

export function CheckNow() {
  const { pending, error, run } = useAction();
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <span className="inline-flex items-center gap-2">
      <Button
        size="sm"
        variant="secondary"
        disabled={pending}
        onClick={() =>
          run(checkMilestonesNowAction, (r) =>
            setMsg(
              r.recorded
                ? `${r.recorded} recorded, ${r.announced} announced`
                : "Nothing new",
            ),
          )
        }
      >
        {pending ? "Checking…" : "Check now"}
      </Button>
      {msg && <span className="text-xs text-zinc-600">{msg}</span>}
      {error && <span className="text-xs text-red-600">{error}</span>}
    </span>
  );
}
