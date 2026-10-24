export async function register() {
  (await import("./lib/sensitive")).installLogScrubbing();
}
