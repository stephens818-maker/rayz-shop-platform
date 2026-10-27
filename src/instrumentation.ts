export async function register() {
  (await import("./lib/deployment")).assertDemoModeAllowed();
  (await import("./lib/sensitive")).installLogScrubbing();
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.DATABASE_URL) await (await import("./server/display")).loadDisplay();
}
