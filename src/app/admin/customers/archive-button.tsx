"use client";

import { useAction } from "@/components/use-action";
import { Button } from "@/components/ui";
import { archiveClientAction } from "./actions";

export function ArchiveClient({ id, archived }: { id: string; archived: boolean }) {
  const { pending, error, run } = useAction();
  if (archived) return <span className="text-sm text-zinc-500">Archived. Hidden from search. History stays.</span>;
  return (
    <span className="inline-flex items-center gap-2">
      <Button size="sm" variant="secondary" disabled={pending} onClick={() => confirm("Archive this client? They leave search. Visits stay.") && run(() => archiveClientAction(id), undefined, "Archived")}>
        Archive client
      </Button>
      {error && <span className="text-xs text-red-600">{error}</span>}
    </span>
  );
}
