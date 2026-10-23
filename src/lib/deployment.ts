/**
 * A hosted demo on sample data: cards run on the simulator or Stripe test mode, nothing is texted, emailed or called
 * (messages show in the outbox instead), and customer sign-in codes are shown on screen. Never set it on a deployment
 * with real clients.
 */
export function demoMode(): boolean {
  return process.env.DEMO_MODE === "true";
}

/** The public origin used in links inside texts, emails and calendar invites. */
export function appBaseUrl(): string {
  if (process.env.APP_BASE_URL) return process.env.APP_BASE_URL.replace(/\/$/, "");
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
  return host ? `https://${host}` : "http://localhost:3000";
}
