export async function register() {
  (await import("./lib/deployment")).assertDemoModeAllowed();
  (await import("./lib/sensitive")).installLogScrubbing();
}
