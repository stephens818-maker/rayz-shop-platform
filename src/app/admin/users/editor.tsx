"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button, Field, Input, Notice, Select } from "@/components/ui";
import {
  inviteUserAction,
  removeUserAction,
  resendInviteAction,
  resetTwoFactorAction,
  revokeInviteAction,
  setRemoteAccessAction,
  setTwoFactorRequiredAction,
  setUserActiveAction,
  updateUserProfileAction,
} from "./actions";

type Result<T = unknown> = { ok: true; data: T } | { ok: false; error: string };

function useRun() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const run = <T,>(fn: () => Promise<Result<T>>, after?: (data: T) => void) =>
    start(async () => {
      setError(null);
      const r = await fn();
      if (!r.ok) return setError(r.error);
      after?.(r.data);
      router.refresh();
    });
  return { pending, error, run };
}

/** The sign-up link, shown only when the email couldn't be sent. */
function InviteLink({ link }: { link: string | null }) {
  if (!link) return null;
  return (
    <Notice tone="amber">
      Email isn&apos;t set up, so the invite wasn&apos;t sent. Give them this link yourself; it works once:{" "}
      <code className="select-all break-all rounded bg-white/70 px-1">{link}</code>
    </Notice>
  );
}

export function InviteForm({
  roles,
  shops,
  brandWide,
  mayGiveRemote,
}: {
  roles: { id: string; name: string; defaultScope: string; remote: boolean }[];
  shops: { id: string; name: string }[];
  /** Only people with every location can invite someone with every location. */
  brandWide: boolean;
  mayGiveRemote: boolean;
}) {
  const { pending, error, run } = useRun();
  const blank = { firstName: "", lastName: "", displayLabel: "", email: "" };
  const [v, setV] = useState(blank);
  const [roleId, setRoleId] = useState("");
  const [scope, setScope] = useState<"all" | "selected">(brandWide ? "all" : "selected");
  const [shopIds, setShopIds] = useState<string[]>([]);
  const [twoFactorRequired, setTwoFactor] = useState(true);
  const [remote, setRemote] = useState(false);
  const [done, setDone] = useState<{ who: string; link: string | null } | null>(null);
  const role = roles.find((r) => r.id === roleId);
  const pickRole = (id: string) => {
    setRoleId(id);
    const r = roles.find((x) => x.id === id);
    if (r) {
      setRemote(r.remote);
      if (brandWide) setScope(r.defaultScope === "all" ? "all" : "selected");
    }
  };
  const set = (k: keyof typeof blank) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setDone(null);
    const next = { ...v, [k]: e.target.value };
    if (k === "firstName" && (!v.displayLabel || v.displayLabel === v.firstName)) next.displayLabel = e.target.value;
    setV(next);
  };
  const invite = () =>
    run(
      () => inviteUserAction({ ...v, roleId, scope, shopIds: scope === "all" ? [] : shopIds, twoFactorRequired, remote }),
      (d) => {
        setDone({ who: v.displayLabel, link: d.link });
        setV(blank);
        setShopIds([]);
      },
    );
  return (
    <div className="space-y-3 p-4">
      <div className="grid gap-3 sm:grid-cols-4">
        <Field label="First name">
          <Input value={v.firstName} onChange={set("firstName")} autoComplete="off" />
        </Field>
        <Field label="Last name (private)">
          <Input value={v.lastName} onChange={set("lastName")} autoComplete="off" />
        </Field>
        <Field label="Display name" hint="Shown in the portal and the audit log.">
          <Input value={v.displayLabel} onChange={set("displayLabel")} maxLength={24} />
        </Field>
        <Field label="Email" hint="The invite goes here; it's their sign-in.">
          <Input type="email" value={v.email} onChange={set("email")} autoComplete="off" />
        </Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Role" hint="A starting set of permissions. Fine-tune them per person after the invite. Only roles you could give are listed.">
          <Select value={roleId} onChange={(e) => pickRole(e.target.value)} aria-label="Role">
            <option value="">Choose a role…</option>
            {roles.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Locations">
          <div className="space-y-2">
            {brandWide && (
              <Select value={scope} onChange={(e) => setScope(e.target.value as "all" | "selected")} aria-label="Locations">
                <option value="all">All locations, including new ones</option>
                <option value="selected">Selected locations</option>
              </Select>
            )}
            {scope === "selected" && (
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                {shops.map((s) => (
                  <label key={s.id} className="flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      className="accent-ink-900"
                      checked={shopIds.includes(s.id)}
                      onChange={(e) => setShopIds(e.target.checked ? [...shopIds, s.id] : shopIds.filter((x) => x !== s.id))}
                    />
                    {s.name}
                  </label>
                ))}
              </div>
            )}
          </div>
        </Field>
      </div>
      <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
        <label className="flex items-center gap-2">
          <input type="checkbox" className="accent-ink-900" checked={twoFactorRequired} onChange={(e) => setTwoFactor(e.target.checked)} />
          Require two-step sign-in (authenticator app)
        </label>
        <label className="flex items-center gap-2" title={mayGiveRemote ? undefined : "You can only give remote access if you have it yourself"}>
          <input type="checkbox" className="accent-ink-900" checked={remote} disabled={!mayGiveRemote && !role?.remote} onChange={(e) => setRemote(e.target.checked)} />
          Can sign in remotely (exempt from locations that only allow the shop&apos;s network)
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button disabled={pending || !roleId || !v.firstName || !v.email} onClick={invite}>
          {pending ? "Inviting…" : "Send invite"}
        </Button>
        {done && !done.link && <span className="text-sm text-zinc-600">Invited {done.who}. The link works once, for 7 days.</span>}
        {error && <span className="text-sm text-red-600">{error}</span>}
      </div>
      {done && <InviteLink link={done.link} />}
    </div>
  );
}

export function ProfileForm({ staffId, initial, emailEditable, readOnly }: { staffId: string; initial: { firstName: string; lastName: string; displayLabel: string; email: string }; emailEditable: boolean; readOnly: boolean }) {
  const { pending, error, run } = useRun();
  const [v, setV] = useState(initial);
  const [saved, setSaved] = useState(false);
  const set = (k: keyof typeof initial) => (e: React.ChangeEvent<HTMLInputElement>) => (setSaved(false), setV({ ...v, [k]: e.target.value }));
  return (
    <div className="space-y-3 p-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="First name">
          <Input value={v.firstName} onChange={set("firstName")} disabled={readOnly} />
        </Field>
        <Field label="Last name (private)">
          <Input value={v.lastName} onChange={set("lastName")} disabled={readOnly} />
        </Field>
        <Field label="Display name">
          <Input value={v.displayLabel} onChange={set("displayLabel")} maxLength={24} disabled={readOnly} />
        </Field>
        <Field label="Sign-in email" hint={emailEditable ? "Changing it signs them out." : "Hidden: you can't see staff contact details."}>
          <Input type="email" value={v.email} onChange={set("email")} disabled={readOnly || !emailEditable} />
        </Field>
      </div>
      {!readOnly && (
        <div className="flex items-center gap-3">
          <Button disabled={pending} onClick={() => run(() => updateUserProfileAction(staffId, v), () => setSaved(true))}>
            Save
          </Button>
          {saved && <span className="text-sm text-zinc-600">Saved</span>}
          {error && <span className="text-sm text-red-600">{error}</span>}
        </div>
      )}
    </div>
  );
}

export interface AccountView {
  staffId: string;
  label: string;
  status: "invited" | "active" | "deactivated";
  twoFactorRequired: boolean;
  twoFactorOn: boolean;
  remote: boolean;
  /** Why they can't be changed by the signed-in person, if not. */
  readOnly: string | null;
  self: boolean;
  mayGiveRemote: boolean;
}

function Row({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
      <div className="max-w-xl">
        <div className="text-sm font-medium">{title}</div>
        <div className="text-xs text-zinc-500">{hint}</div>
      </div>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </li>
  );
}

export function AccountControls({ a }: { a: AccountView }) {
  const { pending, error, run } = useRun();
  const [link, setLink] = useState<string | null>(null);
  const [confirm, setConfirm] = useState("");
  const off = pending || !!a.readOnly;
  return (
    <div>
      {a.readOnly && (
        <div className="px-4 pt-3">
          <Notice tone="amber">{a.readOnly}</Notice>
        </div>
      )}
      <ul className="divide-y divide-zinc-100">
        {a.status === "invited" && (
          <Row title="Invite" hint="They haven't signed up yet. Sending again cancels the old link.">
            <Button size="sm" variant="secondary" disabled={off} onClick={() => run(() => resendInviteAction(a.staffId), (d) => setLink(d.link))}>
              Send again
            </Button>
            <Button size="sm" variant="secondary" disabled={off} onClick={() => run(() => revokeInviteAction(a.staffId))}>
              Cancel invite
            </Button>
          </Row>
        )}
        <Row
          title="Two-step sign-in"
          hint={
            a.twoFactorOn
              ? "Set up: they enter a code from their authenticator app when signing in."
              : a.twoFactorRequired
                ? "Required: they'll set up an authenticator app at their next sign-in."
                : "Not required. Requiring it signs them out, and they set it up at their next sign-in."
          }
        >
          <Button size="sm" variant="secondary" disabled={off || (a.self && a.twoFactorRequired)} onClick={() => run(() => setTwoFactorRequiredAction(a.staffId, !a.twoFactorRequired))}>
            {a.twoFactorRequired ? "Stop requiring" : "Require"}
          </Button>
          {a.twoFactorOn && (
            <Button size="sm" variant="secondary" disabled={off || a.self} onClick={() => run(() => resetTwoFactorAction(a.staffId))}>
              Reset (lost phone)
            </Button>
          )}
        </Row>
        <Row
          title="Remote access"
          hint={
            a.remote
              ? "Can sign in from anywhere, even at locations that only allow sign-in from the shop's network or approved devices."
              : "Follows each location's sign-in rule: at locations that only allow the shop's network, they sign in there or from an approved device."
          }
        >
          <Button size="sm" variant="secondary" disabled={off || a.self || (!a.remote && !a.mayGiveRemote)} onClick={() => run(() => setRemoteAccessAction(a.staffId, !a.remote))}>
            {a.remote ? "Turn off" : "Allow remote access"}
          </Button>
        </Row>
        <Row
          title={a.status === "deactivated" ? "Deactivated" : "Deactivate"}
          hint={a.status === "deactivated" ? "They can't sign in. Everything they did is kept." : "Signs them out at once and stops them signing in. Nothing is deleted; you can reactivate them."}
        >
          <Button size="sm" variant="secondary" disabled={off || a.self} onClick={() => run(() => setUserActiveAction(a.staffId, a.status === "deactivated"))}>
            {a.status === "deactivated" ? "Reactivate" : "Deactivate"}
          </Button>
        </Row>
        <Row title="Remove" hint={`Takes them out of the portal for good: sign-in, authenticator and contact access are cleared, their history stays. Type "${a.label}" to confirm.`}>
          <Input className="h-8 w-40" aria-label="Confirm removal" value={confirm} onChange={(e) => setConfirm(e.target.value)} disabled={off || a.self} placeholder={a.label} />
          <Button size="sm" variant="danger" disabled={off || a.self || confirm.trim() !== a.label} onClick={() => run(() => removeUserAction(a.staffId, confirm), () => (window.location.href = "/admin/users"))}>
            Remove
          </Button>
        </Row>
      </ul>
      {error && <p className="px-4 pb-3 text-sm text-red-600">{error}</p>}
      {link && (
        <div className="px-4 pb-3">
          <InviteLink link={link} />
        </div>
      )}
    </div>
  );
}
