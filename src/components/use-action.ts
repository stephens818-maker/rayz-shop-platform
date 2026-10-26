"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "./toast";

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

/** Runs a server action, keeps its error to show inline, and refreshes the page when it succeeds (with an optional toast). */
export function useAction() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const run = <T>(fn: () => Promise<Result<T>>, ok?: (data: T) => void, done?: string) =>
    start(async () => {
      setError(null);
      const r = await fn();
      if (!r.ok) return setError(r.error);
      ok?.(r.data);
      if (done) toast(done);
      router.refresh();
    });
  return { pending, error, setError, run };
}
