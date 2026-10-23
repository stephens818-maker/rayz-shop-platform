"use client";

import { useActionState, useRef } from "react";
import { Button, Field, Input, Notice } from "@/components/ui";
import { login } from "./actions";

export interface DemoLogin {
  email: string;
  who: string;
  sees: string;
}

export function LoginForm({ next, demo }: { next: string; demo?: { password: string | null; logins: DemoLogin[] } }) {
  const [state, action, pending] = useActionState(login, null);
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
      <form ref={form} action={action} className="mt-5 space-y-4">
        <input type="hidden" name="next" value={next} />
        <Field label="Email">
          <Input name="email" type="email" autoComplete="username" required autoFocus />
        </Field>
        <Field label="Password">
          <Input name="password" type="password" autoComplete="current-password" required />
        </Field>
        {state?.error && <Notice tone="red">{state.error}</Notice>}
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
