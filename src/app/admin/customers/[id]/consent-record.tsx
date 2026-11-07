import { Badge, Card, CardHeader } from "@/components/ui";
import type { ConsentSource } from "@/db/schema";
import { CONSENT_CHANNELS, CONSENT_COLUMN, CONSENT_TEXTS, type ConsentFlags } from "@/domain/consent-texts";
import { formatDateTime } from "@/lib/time";
import { consentHistory } from "@/server/consent-events";

const SOURCE_LABEL: Record<ConsentSource, string> = { ios: "iPhone app", android: "Android app", web: "website", pos: "staff", import: "Squire import", sms: "text reply", email: "email link" };

/** What the client agreed to on each channel and the record behind it. Read-only: marketing is the client's own choice. */
export async function ConsentRecord({ customerId, flags }: { customerId: string; flags: ConsentFlags }) {
  const events = await consentHistory(customerId, 15);
  return (
    <Card>
      <CardHeader title="Consent" subtitle="Marketing is a separate yes per channel that only the client can give, in the app or on their account page." />
      <div className="space-y-3 p-4 text-sm">
        <div className="flex flex-wrap gap-1.5">
          {CONSENT_CHANNELS.map((ch) => (
            <Badge key={ch} tone={flags[CONSENT_COLUMN[ch]] ? "green" : "gray"}>
              {CONSENT_TEXTS[ch].label}: {flags[CONSENT_COLUMN[ch]] ? "yes" : "no"}
            </Badge>
          ))}
        </div>
        {events.length ? (
          <ul className="space-y-1 text-xs text-zinc-600">
            {events.map((e, i) => (
              <li key={i}>
                {formatDateTime(e.createdAt)}: {CONSENT_TEXTS[e.channel].label} {e.action === "granted" ? "turned on" : "turned off"} via {SOURCE_LABEL[e.source]}
                {e.appVersion ? ` ${e.appVersion}` : ""} <span className="text-zinc-400">({e.textVersion})</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-zinc-500">No changes recorded yet.</p>
        )}
      </div>
    </Card>
  );
}
