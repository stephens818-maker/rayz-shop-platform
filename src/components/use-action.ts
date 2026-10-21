"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

/** Runs a server action, keeps its error to show inline, and refreshes the page when it succeeds. */
export function useAction() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const run = <T>(fn: () => Promise<Result<T>>, ok?: (data: T) => void) =>
    start(async () => {
      setError(null);
      const r = await fn();
      if (!r.ok) return setError(r.error);
      ok?.(r.data);
      router.refresh();
    });
  return { pending, error, setError, run };
}
