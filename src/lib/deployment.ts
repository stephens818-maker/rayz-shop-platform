/**
 * A hosted demo on sample data: cards run on the simulator or Stripe test mode, nothing is texted, emailed or called
 * (messages show in the outbox instead), and customer sign-in codes are shown on screen. Never set it on a deployment
 * with real clients.
 */
export function demoMode(): boolean {
  return process.env.DEMO_MODE === "true";
}

const NOT_REAL = new Set(["", "disabled", "console", "simulator"]);

/**
 * What marks a deployment with real clients, so DEMO_MODE can't run on it: APP_ENV=production (set
 * in DEPLOY.md's production steps), a live Stripe key, or a real text, email, voice or push
 * provider. The hosted demo runs in Vercel's production environment, so VERCEL_ENV alone isn't one.
 */
export function productionSignals(env: Record<string, string | undefined> = process.env): string[] {
  const out: string[] = [];
  if (env.APP_ENV === "production") out.push("APP_ENV=production");
  if (/^(sk|rk)_live_/.test(env.STRIPE_SECRET_KEY ?? "")) out.push("a live STRIPE_SECRET_KEY");
  for (const k of ["SMS", "EMAIL", "VOICE", "PUSH"]) {
    const v = (env[`NOTIFICATIONS_${k}_PROVIDER`] ?? "").toLowerCase();
    if (!NOT_REAL.has(v)) out.push(`NOTIFICATIONS_${k}_PROVIDER=${v}`);
  }
  return out;
}

/** Stops the build and the server when DEMO_MODE is on in a production environment. */
export function assertDemoModeAllowed(env: Record<string, string | undefined> = process.env) {
  if (env.DEMO_MODE !== "true") return;
  const why = productionSignals(env);
  if (why.length) throw new Error(`DEMO_MODE=true can't run in production (${why.join(", ")}). Unset DEMO_MODE, or deploy the demo without production settings.`);
}

/** Short git sha of this build, or "local" when it isn't a Vercel deploy. */
export function buildRevision(): string {
  const sha = process.env.VERCEL_GIT_COMMIT_SHA || process.env.GIT_COMMIT || "";
  return sha ? sha.slice(0, 7) : "local";
}

/** The public origin used in links inside texts, emails and calendar invites. */
export function appBaseUrl(): string {
  if (process.env.APP_BASE_URL) return process.env.APP_BASE_URL.replace(/\/$/, "");
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
  return host ? `https://${host}` : "http://localhost:3000";
}
