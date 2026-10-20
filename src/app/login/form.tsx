"use client";

import { useActionState } from "react";
import { Button, Field, Input, Notice } from "@/components/ui";
import { login } from "./actions";

export function LoginForm({ next }: { next: string }) {
  const [state, action, pending] = useActionState(login, null);
  return (
    <form action={action} className="mt-5 space-y-4">
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
  );
}
