import { groupFamilies, type ClientHit } from "@/domain/client-search";
import { ClientBadges } from "./client-badges";
import { StarBadge, cx } from "./ui";

const visitDate = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

/** The initials avatar, or the client's photo when one is on file and the viewer sees photos. */
export function ClientAvatar({ hit, size = 36 }: { hit: Pick<ClientHit, "id" | "firstName" | "lastName" | "photo">; size?: number }) {
  const initials = `${hit.firstName[0] ?? ""}${hit.lastName?.[0] ?? ""}`.toUpperCase();
  return hit.photo ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={`/admin/customers/${hit.id}/photo`} alt="" width={size} height={size} className="shrink-0 rounded-full object-cover ring-1 ring-zinc-200" style={{ width: size, height: size }} />
  ) : (
    <span aria-hidden className="inline-flex shrink-0 items-center justify-center rounded-full bg-zinc-100 text-xs font-semibold text-zinc-600" style={{ width: size, height: size }}>
      {initials}
    </span>
  );
}

/**
 * A search result with what tells two clients apart on a shared screen: first name and last
 * initial, nickname, photo, rating, masked phone, last visit and where, usual barber, and how it
 * matched.
 */
export function ClientHitRow({ hit, className, hideKids }: { hit: ClientHit; className?: string; hideKids?: boolean }) {
  const sub = [hit.family?.guardian ? `Child of ${hit.family.guardian.short}` : hit.phone, hit.lastVisit ? `Last in ${visitDate(hit.lastVisit.at)}${hit.lastVisit.shop ? ` at ${hit.lastVisit.shop}` : ""}` : "No visits yet", hit.barber && `Usually ${hit.barber}`].filter(Boolean);
  const how = hit.matched.filter((m) => m !== "Name");
  return (
    <span className={cx("flex min-w-0 items-center gap-2.5", className)}>
      <ClientAvatar hit={hit} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate font-medium text-zinc-900">{hit.short}</span>
          {hit.nickname && <span className="truncate text-zinc-500">&ldquo;{hit.nickname}&rdquo;</span>}
          <StarBadge rating={hit.rating} showCount={false} />
          <span className="ml-auto shrink-0 font-mono text-[11px] text-zinc-400">C{hit.number}</span>
        </span>
        <span className="block truncate text-xs text-zinc-500">{sub.join(" · ")}</span>
        {!hideKids && hit.family && hit.family.kids.length > 0 && (
          <span className="block truncate text-[11px] text-zinc-500" data-testid="hit-kids">
            Kids: {hit.family.kids.map((k) => (k.age != null ? `${k.firstName} (${k.age})` : k.firstName)).join(", ")}
          </span>
        )}
        <ClientBadges badges={hit.badges} max={3} className="mt-0.5" />
        {how.length > 0 && <span className="block truncate text-[11px] text-brand-700">Matched {how.join(", ")}</span>}
      </span>
    </span>
  );
}

/**
 * Search results as families, for booking, walk-ins and the POS: each account with its children
 * listed underneath (first name and age, as the searcher sees birthdays), each one pickable. A
 * child the search matched sits under their parent; the parent's row shows the masked phone.
 */
export function FamilyPickList({ hits, onPick, title }: { hits: ClientHit[]; onPick: (account: ClientHit, memberId: string) => void; title?: string }) {
  return (
    <>
      {title && <div className="px-3 py-1.5 text-[11px] font-medium uppercase tracking-wide text-zinc-400">{title}</div>}
      {groupFamilies(hits).map(({ hit, kids }) => (
        <div key={hit.id} data-testid="pick-family">
          <button type="button" onClick={() => onPick(hit, hit.id)} className="block w-full px-3 py-2 text-left text-sm hover:bg-zinc-50">
            <ClientHitRow hit={hit} hideKids={kids.length > 0} />
          </button>
          {kids.map((k) => (
            <button
              type="button"
              key={k.id}
              data-testid="pick-kid"
              onClick={() => onPick(hit, k.id)}
              className={cx("flex w-full items-center gap-2 py-1.5 pl-[3.25rem] pr-3 text-left text-sm hover:bg-zinc-50", k.matched && "bg-brand-50")}
            >
              <span aria-hidden className="text-zinc-300">↳</span>
              <span className="font-medium text-zinc-800">{k.firstName}</span>
              {k.age != null && <span className="text-xs text-zinc-500">{k.age}</span>}
              <span className="ml-auto text-[11px] text-zinc-400">{k.matched ? "Matched child's name" : "Child"}</span>
            </button>
          ))}
        </div>
      ))}
    </>
  );
}
