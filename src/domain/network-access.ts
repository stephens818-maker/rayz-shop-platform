/**
 * Where staff may sign in from. Each location can limit sign-in to its own network (allowed public
 * IPs and CIDR ranges), to devices a manager approved, or to either or both. People with "Sign in
 * from anywhere" are exempt. Pure: the server loads the rules, the request's IP and device, and
 * calls these on every request.
 */
import { z } from "zod";
import { ipInList, parseCidr } from "./time-clock";

export const BLOCK_MESSAGE = "Sign-in is only allowed from the shop.";

export const NETWORK_REQUIREMENTS = ["ip", "device", "either", "both"] as const;
export type NetworkRequirement = (typeof NETWORK_REQUIREMENTS)[number];

export const REQUIREMENT_LABEL: Record<NetworkRequirement, string> = {
  ip: "From the shop's network (an allowed IP)",
  device: "On an approved device",
  either: "From the shop's network or on an approved device",
  both: "From the shop's network and on an approved device",
};

export interface ShopNetworkRule {
  enabled: boolean;
  require: NetworkRequirement;
  /** The shop's public IPs or CIDR ranges, as the internet sees its Wi-Fi. */
  allowedIps: string[];
}

export const DEFAULT_NETWORK_RULE: ShopNetworkRule = { enabled: false, require: "ip", allowedIps: [] };

export const needsIps = (r: NetworkRequirement) => r === "ip" || r === "both";
export const acceptsDevices = (r: Pick<ShopNetworkRule, "enabled" | "require">) => r.enabled && r.require !== "ip";

/** Why an allowed-IP entry can't be used, or null. Ranges wider than a /16 (IPv6 /32) would let in far more than one shop. */
export function networkEntryProblem(raw: string): string | null {
  const c = parseCidr(raw);
  if (!c) return `"${raw}" isn't an IP address or range (like 203.0.113.7 or 203.0.113.0/24)`;
  if ((c.v === 4 && c.bits < 16) || (c.v === 6 && c.bits < 32)) return `"${raw}" covers too much of the internet. Use the shop's own address, or a range no wider than /16 (IPv6 /32).`;
  return null;
}

/** "203.0.113.7, 198.51.100.0/24" or one per line, as typed. */
export const splitNetworks = (text: string) => [...new Set(text.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean))];

export const NetworkRuleSchema = z
  .object({
    enabled: z.boolean(),
    require: z.enum(NETWORK_REQUIREMENTS),
    allowedIps: z
      .array(z.string().trim().min(1).max(64))
      .max(50, "Keep it to 50 addresses or ranges")
      .transform((l) => [...new Set(l)]),
  })
  .superRefine((r, c) => {
    for (const ip of r.allowedIps) {
      const p = networkEntryProblem(ip);
      if (p) c.addIssue({ code: "custom", message: p, path: ["allowedIps"] });
    }
    if (r.enabled && needsIps(r.require) && !r.allowedIps.length)
      c.addIssue({ code: "custom", message: "Add at least one allowed IP address or range, or choose approved devices only", path: ["allowedIps"] });
  });

/** A stored rule, read leniently: unknown keys and unusable entries are dropped. A rule left on with no usable IPs lets nobody in. */
export function shopNetworkRule(raw: unknown): ShopNetworkRule {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const require = NETWORK_REQUIREMENTS.includes(r.require as NetworkRequirement) ? (r.require as NetworkRequirement) : DEFAULT_NETWORK_RULE.require;
  const allowedIps = Array.isArray(r.allowedIps) ? r.allowedIps.filter((x): x is string => typeof x === "string" && !networkEntryProblem(x)) : [];
  return { enabled: r.enabled === true, require, allowedIps };
}

export interface BrandNetworkSettings {
  /** Email the Brand Owner and brand admins when a sign-in is blocked (at most once an hour per person and location). */
  alertOnBlock: boolean;
}

export const DEFAULT_BRAND_NETWORK: BrandNetworkSettings = { alertOnBlock: true };
export const BrandNetworkSchema = z.object({ alertOnBlock: z.boolean() });

export function brandNetworkSettings(raw: unknown): BrandNetworkSettings {
  const p = BrandNetworkSchema.partial().safeParse(raw ?? {});
  return { ...DEFAULT_BRAND_NETWORK, ...(p.success ? p.data : {}) };
}

export interface NetworkEvidence {
  ip: string | null;
  /** Shops this browser is an approved device for. */
  deviceShopIds: readonly string[];
}

export interface RuleCheck {
  ok: boolean;
  ipOk: boolean;
  deviceOk: boolean;
}

export function ruleAllows(rule: ShopNetworkRule, shopId: string, e: NetworkEvidence): RuleCheck {
  const ipOk = ipInList(e.ip, rule.allowedIps);
  const deviceOk = e.deviceShopIds.includes(shopId);
  if (!rule.enabled) return { ok: true, ipOk, deviceOk };
  const ok = rule.require === "ip" ? ipOk : rule.require === "device" ? deviceOk : rule.require === "either" ? ipOk || deviceOk : ipOk && deviceOk;
  return { ok, ipOk, deviceOk };
}

export interface GateShop {
  shopId: string;
  rule: ShopNetworkRule;
  /** They may sign in from anywhere at this shop. */
  exempt: boolean;
}

export interface BlockedShop extends RuleCheck {
  shopId: string;
  require: NetworkRequirement;
}

export interface NetworkVerdict {
  /** Shops they can't work in from here. */
  blocked: BlockedShop[];
  /** Every shop they have is blocked: no session at all. */
  full: boolean;
}

/** Which of someone's shops they can't reach from this request. Exempt shops and shops without a rule always pass. */
export function networkVerdict(shops: readonly GateShop[], e: NetworkEvidence): NetworkVerdict {
  const blocked: BlockedShop[] = [];
  for (const s of shops) {
    if (s.exempt || !s.rule.enabled) continue;
    const r = ruleAllows(s.rule, s.shopId, e);
    if (!r.ok) blocked.push({ shopId: s.shopId, require: s.rule.require, ...r });
  }
  return { blocked, full: shops.length > 0 && blocked.length === shops.length };
}

/** What was missing, in words for the audit log and the brand portal. */
export function blockedWhy(b: Pick<BlockedShop, "require" | "ipOk" | "deviceOk">): string {
  const net = "not on the shop's network";
  const dev = "not an approved device";
  if (b.require === "ip") return net;
  if (b.require === "device") return dev;
  if (b.require === "either") return `${net} or an approved device`;
  return [!b.ipOk && net, !b.deviceOk && dev].filter(Boolean).join(" and ") || net;
}
