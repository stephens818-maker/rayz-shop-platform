/**
 * A fake cookie jar so tests can call admin pages, server actions and route handlers as a given
 * staff member. Test files mock next/headers with `headersMock` and sign in with `signInAs`.
 * `jar.ip` is the address the hosting proxy reports, as on a deployment with one trusted proxy.
 */
export const jar: { token?: string; shop?: string; device?: string; ip?: string; trusted?: string; deviceRequest?: string; userAgent?: string } = {};

process.env.TRUSTED_PROXY_HOPS ??= "1";

const COOKIES = { rayz_session: "token", rayz_shop: "shop", rayz_clock_device: "device", rayz_trusted_device: "trusted", rayz_device_request: "deviceRequest" } as const;

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
    },
  }),
  headers: async () => new Headers({ ...(jar.ip ? { "x-forwarded-for": jar.ip } : {}), ...(jar.userAgent ? { "user-agent": jar.userAgent } : {}) }),
};

export async function signInAs(staffId: string | null, shop?: string) {
  const { signToken } = await import("@/server/auth/tokens");
  jar.token = staffId ? await signToken({ sub: staffId }, "staff_session", 600) : undefined;
  jar.shop = shop;
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
