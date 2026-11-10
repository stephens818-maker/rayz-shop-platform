import { Badge } from "@/components/ui";
import { DELIVERY_TONE, type DeliveryState } from "@/domain/notification-delivery";
import { formatDateTime } from "@/lib/time";

export interface MessageHistoryLine {
  id: string;
  label: string;
  channel: string;
  to: string;
  state: DeliveryState;
  stateLabel: string;
  at: Date | string;
  shop: string | null;
  error: string | null;
}

/** Messages to a client: what, which channel, to the number or email as the viewer may see it, and where it got to. */
export function MessageHistoryList({ lines, showShop }: { lines: MessageHistoryLine[]; showShop?: boolean }) {
  return (
    <ul className="divide-y divide-zinc-100 text-sm" data-testid="message-history">
      {lines.map((l) => (
        <li key={l.id} className="flex items-start justify-between gap-3 py-2">
          <div className="min-w-0">
            <div className="font-medium text-zinc-800">{l.label}</div>
            <div className="text-xs text-zinc-500">
              <span className="uppercase">{l.channel}</span> to {l.to} · {formatDateTime(new Date(l.at))}
              {showShop && l.shop ? ` · ${l.shop}` : ""}
            </div>
            {l.error && <div className="text-xs text-red-600">{l.error}</div>}
          </div>
          <Badge tone={DELIVERY_TONE[l.state]}>{l.stateLabel}</Badge>
        </li>
      ))}
    </ul>
  );
}
