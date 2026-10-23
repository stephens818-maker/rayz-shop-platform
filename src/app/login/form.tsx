"use client";

import { useActionState, useRef, useState, useTransition } from "react";
import { Button, Field, Input, Notice, Select } from "@/components/ui";
import { BLOCK_MESSAGE } from "@/domain/network-access";
import { login, requestDeviceAction, type LoginState } from "./actions";

type Blocked = NonNullable<LoginState["blocked"]>;

function BlockedNotice({ blocked }: { blocked: Blocked }) {
  const [label, setLabel] = useState("");
  const [shopId, setShopId] = useState(blocked.deviceShops[0]?.id ?? "");
  const [pending, start] = useTransition();
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <div role="alert" className="space-y-3 rounded-lg bg-red-50 p-3 text-sm text-red-800 ring-1 ring-red-200">
      <p className="font-semibold">{BLOCK_MESSAGE}</p>
      <p className="text-red-700">This location only lets staff sign in from the shop&apos;s own network{blocked.deviceShops.length ? " or an approved device" : ""}. Ask your manager if you need access from somewhere else.</p>
      {blocked.deviceShops.length > 0 &&
        (result?.ok ? (
          <p className="rounded bg-white/70 px-2 py-1.5 text-emerald-800">{result.text}</p>
        ) : (
          <form
            className="space-y-2 border-t border-red-200 pt-3"
            onSubmit={(e) => {
              e.preventDefault();
              start(async () => {
                const r = await requestDeviceAction({ shopId, label });
                setResult(r.ok ? { ok: true, text: `Asked ${r.data.shop}'s managers to approve this device. Once they do, sign in here again.` } : { ok: false, text: r.error });
              });
            }}
          >
            <div className="font-medium text-zinc-800">Is this one of the shop&apos;s devices? Ask a manager to approve it.</div>
            <Field label="Device name">
              <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Front desk iPad" maxLength={40} required />
            </Field>
            {blocked.deviceShops.length > 1 && (
              <Field label="Shop">
                <Select value={shopId} onChange={(e) => setShopId(e.target.value)}>
                  {blocked.deviceShops.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            {result && !result.ok && <p className="text-red-700">{result.text}</p>}
            <Button type="submit" variant="secondary" size="sm" disabled={pending}>
              {pending ? "Sending…" : "Ask for approval"}
            </Button>
          </form>
        ))}
    </div>
  );
}

export interface DemoLogin {
  email: string;
  who: string;
  sees: string;
}

export function LoginForm({ next, blocked, demo }: { next: string; blocked?: Blocked; demo?: { password: string | null; logins: DemoLogin[] } }) {
  const [state, action, pending] = useActionState(login, null);
  const shownBlock = state?.blocked ?? (state ? undefined : blocked);
  const form = useRef<HTMLFormElement>(null);
  const signInAs = (email: string) => {
    const f = form.current!;
    const password = f.elements.namedItem("password") as HTMLInputElement;
    (f.elements.namedItem("email") as HTMLInputElement).value = email;
    if (!demo!.password) return password.focus();
    password.value = demo!.password;
    f.requestSubmit();
  };
  return (
    <>
      {shownBlock && (
        <div className="mt-5">
          <BlockedNotice key={shownBlock.deviceShops.map((s) => s.id).join()} blocked={shownBlock} />
        </div>
      )}
      <form ref={form} action={action} className="mt-5 space-y-4">
        <input type="hidden" name="next" value={next} />
        <Field label="Email">
          <Input name="email" type="email" autoComplete="username" required autoFocus />
        </Field>
        <Field label="Password">
          <Input name="password" type="password" autoComplete="current-password" required />
        </Field>
        {!shownBlock && state?.error && <Notice tone="red">{state.error}</Notice>}
        <Button type="submit" className="w-full" disabled={pending}>
          {pending ? "Signing in…" : "Sign in"}
        </Button>
      </form>
      {demo && (
        <div className="mt-6 border-t border-zinc-100 pt-4">
          <div className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Try a demo login</div>
          <div className="mt-2 grid gap-2">
            {demo.logins.map((l) => (
              <button
                key={l.email}
                type="button"
                disabled={pending}
                onClick={() => signInAs(l.email)}
                className="rounded-lg border border-zinc-200 px-3 py-2 text-left text-sm transition hover:border-zinc-400 hover:bg-zinc-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 disabled:opacity-60"
              >
                <span className="font-medium text-zinc-900">{l.who}</span>
                <span className="block text-xs text-zinc-500">
                  {l.email} · {l.sees}
                </span>
              </button>
            ))}
          </div>
          <p className="mt-2 text-xs text-zinc-500">
            {demo.password ? (
              <>
                Every login uses the password <code className="rounded bg-zinc-100 px-1">{demo.password}</code>.
              </>
            ) : (
              "Every login uses the demo password you were given."
            )}
          </p>
        </div>
      )}
    </>
  );
}
