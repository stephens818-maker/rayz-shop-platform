"use client";

import { Button, Field, Select, Textarea } from "@/components/ui";
import { NETWORK_REQUIREMENTS, REQUIREMENT_LABEL, needsIps, splitNetworks, type NetworkRequirement, type ShopNetworkRule } from "@/domain/network-access";
import { ipInList } from "@/domain/time-clock";

export interface RuleDraft {
  enabled: boolean;
  require: NetworkRequirement;
  ips: string;
}

export const ruleDraft = (r: ShopNetworkRule): RuleDraft => ({ enabled: r.enabled, require: r.require, ips: r.allowedIps.join("\n") });
export const ruleFromDraft = (d: RuleDraft): ShopNetworkRule => ({ enabled: d.enabled, require: d.require, allowedIps: splitNetworks(d.ips) });

/**
 * A location's sign-in restriction: on or off, what it needs, and its allowed IPs and ranges, with a
 * button to add the address this browser is on. Warns when saving would shut out the person editing.
 */
export function NetworkRuleFields({
  value,
  onChange,
  myIp,
  exempt,
  shopName,
}: {
  value: RuleDraft;
  onChange: (v: RuleDraft) => void;
  myIp: string | null;
  /** The person editing may sign in from anywhere. */
  exempt: boolean;
  shopName: string;
}) {
  const list = splitNetworks(value.ips);
  const onList = myIp ? ipInList(myIp, list) : false;
  const set = (p: Partial<RuleDraft>) => onChange({ ...value, ...p });
  return (
    <div className="space-y-3">
      <label className="flex items-center gap-2 text-sm font-medium text-zinc-800">
        <input type="checkbox" checked={value.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
        Only allow staff to sign in to {shopName} from the shop
      </label>
      <div className={value.enabled ? "space-y-3" : "space-y-3 opacity-60"}>
        <Field label="Staff can sign in" hint="People with “Can access remotely” (the Brand Admin role to start) are never limited.">
          <Select value={value.require} onChange={(e) => set({ require: e.target.value as NetworkRequirement })} className="max-w-md">
            {NETWORK_REQUIREMENTS.map((r) => (
              <option key={r} value={r}>
                {REQUIREMENT_LABEL[r]}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="Allowed IP addresses and ranges"
          hint={
            <>
              The shop&apos;s public address as the internet sees its Wi-Fi, like 203.0.113.7, or a range like 203.0.113.0/24. One per line.
              {value.require === "device" ? " Not used while the shop takes approved devices only." : ""}
            </>
          }
        >
          <Textarea rows={3} value={value.ips} onChange={(e) => set({ ips: e.target.value })} className="font-mono text-xs" aria-label={`Allowed IP addresses for ${shopName}`} />
        </Field>
        <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-600">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={!myIp || list.includes(myIp)}
            onClick={() => myIp && set({ ips: [...list, myIp].join("\n") })}
          >
            Use my current IP
          </Button>
          {myIp ? (
            <span>
              You&apos;re on <code className="rounded bg-zinc-100 px-1">{myIp}</code>
              {onList ? ", which is on the list." : ". Add it only if you're at the shop right now."}
            </span>
          ) : (
            <span>The server can&apos;t see your address here, so add the shop&apos;s by hand.</span>
          )}
        </div>
        {value.enabled && !exempt && needsIps(value.require) && !onList && (
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 ring-1 ring-amber-200">
            You aren&apos;t on this list and you don&apos;t have &ldquo;Can access remotely&rdquo;, so once this is saved you&apos;ll only reach {shopName} from its network.
          </p>
        )}
      </div>
    </div>
  );
}
