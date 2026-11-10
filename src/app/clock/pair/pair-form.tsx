"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, Input } from "@/components/ui";
import { pairThisDeviceAction } from "../actions";

export function PairForm({ initialCode }: { initialCode: string }) {
  const router = useRouter();
  const [code, setCode] = useState(initialCode);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  return (
    <form
      className="space-y-3"
      onSubmit={async (e) => {
        e.preventDefault();
        setPending(true);
        setError(null);
        const r = await pairThisDeviceAction(code);
        setPending(false);
        if (!r.ok) return setError(r.error);
        router.replace("/clock");
      }}
    >
      <Input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="K7QD-M3XP" maxLength={20} autoCapitalize="characters" autoComplete="off" aria-label="Pairing code" className="font-mono text-lg tracking-wider" />
      <Button disabled={pending || code.replace(/[^A-Za-z0-9]/g, "").length !== 8}>Pair this device</Button>
      {error && <p className="text-sm text-red-700">{error}</p>}
    </form>
  );
}
