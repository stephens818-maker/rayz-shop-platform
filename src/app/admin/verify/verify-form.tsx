"use client";

import { useState } from "react";
import { Button, Input } from "@/components/ui";
import { stepUpAction } from "../my-security/actions";

export function VerifyForm({ factor, next }: { factor: "code" | "password"; next: string }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  return (
    <form
      className="space-y-3"
      onSubmit={async (e) => {
        e.preventDefault();
        setPending(true);
        setError(null);
        const r = await stepUpAction(factor === "code" ? { code: value } : { password: value });
        setPending(false);
        if (!r.ok) return setError(r.error);
        window.location.assign(next);
      }}
    >
      <Input
        type={factor === "code" ? "text" : "password"}
        inputMode={factor === "code" ? "numeric" : undefined}
        autoComplete={factor === "code" ? "one-time-code" : "current-password"}
        aria-label={factor === "code" ? "Authenticator code" : "Password"}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        autoFocus
      />
      {error && <p className="text-sm text-red-700">{error}</p>}
      <Button disabled={pending || !value.trim()}>Confirm and continue</Button>
    </form>
  );
}
