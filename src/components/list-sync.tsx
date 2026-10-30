"use client";

import { SyncMsg, useSyncSave } from "./brand-sync";
import { Button } from "./ui";

/**
 * Which shops have a row of a brand list (src/server/brand-sync/lists.ts). `offer` opens the brand
 * change scope to pick the shops that get it, `remove` the ones that drop it; an editor calls
 * `offer` right after adding a row, since a new one starts at no shop.
 */
export function useListSync(list: string) {
  const s = useSyncSave();
  const change = (
    id: string,
    label: string,
    available: boolean,
    onDone?: () => void,
  ) =>
    s.save({
      label: `${label}: ${available ? "offered" : "removed"}`,
      changes: [{ type: "list", item: `${list}:${id}`, value: { available } }],
      onDone: () => onDone?.(),
    });
  return {
    ...s,
    offer: (id: string, label: string, onDone?: () => void) =>
      change(id, label, true, onDone),
    remove: (id: string, label: string, onDone?: () => void) =>
      change(id, label, false, onDone),
  };
}

/** A row's "Offer at…" and "Remove from…" buttons, with the dialog and the result line. */
export function ListShops({
  list,
  id,
  label,
  disabled,
}: {
  list: string;
  id: string;
  label: string;
  disabled?: boolean;
}) {
  const s = useListSync(list);
  return (
    <span
      className="inline-flex flex-wrap items-center gap-1"
      data-testid={`list-shops-${id}`}
    >
      <Button
        size="sm"
        variant="ghost"
        disabled={disabled || s.pending}
        onClick={() => s.offer(id, label)}
        title="Pick the shops that get this"
      >
        Offer at…
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabled={disabled || s.pending}
        onClick={() => s.remove(id, label)}
        title="Pick the shops that drop this"
      >
        Remove from…
      </Button>
      <SyncMsg msg={s.msg} />
      {s.dialog}
    </span>
  );
}
