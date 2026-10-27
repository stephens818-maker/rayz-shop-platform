/**
 * A fake cookie jar so tests can call admin pages, server actions and route handlers as a given
 * staff member. Test files mock next/headers with `headersMock` and sign in with `signInAs`.
 * `jar.ip` is the address the hosting proxy reports, as on a deployment with one trusted proxy.
 */
export const jar: { token?: string; shop?: string; device?: string; ip?: string; trusted?: string; deviceRequest?: string; userAgent?: string; handoff?: string; browser?: string; sid?: string } = {};

process.env.TRUSTED_PROXY_HOPS ??= "1";

const COOKIES = {
  rayz_session: "token",
  rayz_shop: "shop",
  rayz_clock_device: "device",
  rayz_trusted_device: "trusted",
  rayz_device_request: "deviceRequest",
  rayz_handoff: "handoff",
  rayz_browser: "browser",
} as const;

export const headersMock = {
  cookies: async () => ({
    get: (name: string) => {
      const key = COOKIES[name as keyof typeof COOKIES];
      const value = key ? jar[key] : undefined;
      return value ? { name, value } : undefined;
    },
    set(name: string, value: string) {
      const key = COOKIES[name as keyof typeof COOKIES];
      if (key && key !== "token") jar[key] = value;
    },
    delete(c: string | { name: string }) {
      const name = typeof c === "string" ? c : c.name;
      if (name === "rayz_device_request") jar.deviceRequest = undefined;
      if (name === "rayz_handoff") jar.handoff = undefined;
    },
  }),
  headers: async () => new Headers({ ...(jar.ip ? { "x-forwarded-for": jar.ip } : {}), ...(jar.userAgent ? { "user-agent": jar.userAgent } : {}) }),
};

/** Signs in as they would on the web: a session row (stepped up just now) and its cookie. */
export async function signInAs(staffId: string | null, shop?: string) {
  const { signToken } = await import("@/server/auth/tokens");
  const { openWebSession } = await import("@/server/auth/sessions");
  jar.sid = staffId ? await openWebSession(staffId, { ip: jar.ip ?? null, userAgent: jar.userAgent ?? null, deviceKey: jar.browser ?? null }) : undefined;
  jar.token = staffId ? await signToken({ sub: staffId, sid: jar.sid }, "staff_session", 600) : undefined;
  jar.shop = shop;
}

/** Moves this session's last sign-in or step-up back, so reveal, export and refund ask again. */
export async function staleStepUp(minutes = 16) {
  const { db } = await import("@/db");
  const { staffWebSessions } = await import("@/db/schema");
  const { eq } = await import("drizzle-orm");
  if (jar.sid) await db.update(staffWebSessions).set({ stepUpAt: new Date(Date.now() - minutes * 60_000) }).where(eq(staffWebSessions.id, jar.sid));
}

/** Where a Next redirect() was going, or null if this wasn't one. */
export function redirectTarget(e: unknown): string | null {
  const d = (e as { digest?: unknown } | null)?.digest;
  return typeof d === "string" && d.startsWith("NEXT_REDIRECT") ? d.split(";")[2] : null;
}

/** "ok", "denied" (sent back to the dashboard), "login", "404", or "redirect:<url>". */
export async function pageOutcome(render: () => Promise<unknown>): Promise<string> {
  try {
    await render();
    return "ok";
  } catch (e) {
    const to = redirectTarget(e);
    if (to === "/admin?denied=1") return "denied";
    if (to === "/login") return "login";
    if (to) return `redirect:${to}`;
    const d = (e as { digest?: unknown } | null)?.digest;
    if (typeof d === "string" && d.includes(";404")) return "404";
    throw e;
  }
}
