/**
 * A fake cookie jar so tests can call admin pages, server actions and route handlers as a given
 * staff member. Test files mock next/headers with `headersMock` and sign in with `signInAs`.
 */
export const jar: { token?: string; shop?: string } = {};

export const headersMock = {
  cookies: async () => ({
    get: (name: string) => {
      const value = name === "rayz_session" ? jar.token : name === "rayz_shop" ? jar.shop : undefined;
      return value ? { name, value } : undefined;
    },
    set() {},
    delete() {},
  }),
  headers: async () => new Headers(),
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
