"use client";

import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";
import { useAction } from "@/components/use-action";
import { deleteReportAction, duplicateReportAction } from "./actions";

export function RowActions({ id, name, build, mayEdit }: { id: string; name: string; build: boolean; mayEdit: boolean }) {
  const router = useRouter();
  const { pending, error, run } = useAction();
  return (
    <span className="inline-flex flex-col items-end gap-1">
      <span className="inline-flex gap-1.5">
        {build && (
          <Button type="button" size="sm" variant="secondary" disabled={pending} onClick={() => run(() => duplicateReportAction(id), (r) => router.push(`/admin/reports/custom/${r.id}`))}>
            Duplicate
          </Button>
        )}
        {mayEdit && (
          <Button type="button" size="sm" variant="danger" disabled={pending} onClick={() => confirm(`Delete "${name}"?`) && run(() => deleteReportAction(id))}>
            Delete
          </Button>
        )}
      </span>
      {error && <span className="max-w-56 text-xs text-red-600">{error}</span>}
    </span>
  );
}
