"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui";
import { mergeCustomersAction } from "../actions";

type P = { id: string; label: string };

export function MergeButtons({ a, b }: { a: P; b: P }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const merge = (keep: P, drop: P) => {
    if (!confirm(`Keep ${keep.label} and merge ${drop.label} into it? This can't be undone (the audit log keeps a copy).`)) return;
    start(async () => {
      const r = await mergeCustomersAction(keep.id, drop.id);
      if (!r.ok) return setError(r.error);
      router.refresh();
    });
  };
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex gap-1">
        <Button size="sm" variant="secondary" disabled={pending} onClick={() => merge(a, b)}>
          Keep A
        </Button>
        <Button size="sm" variant="secondary" disabled={pending} onClick={() => merge(b, a)}>
          Keep B
        </Button>
      </div>
      {error && <span className="text-xs text-red-600">{error}</span>}
    </div>
  );
}
