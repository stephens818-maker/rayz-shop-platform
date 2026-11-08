/**
 * A few seconds of memory for brand-setting reads on a warm server. Tests and transactions read
 * the database. A write drops the memory so the next read sees the change.
 */
const hits = new Map<string, { at: number; value: unknown }>();
const MS = 15_000;

export function memoRead<T>(key: string, load: () => Promise<T>): Promise<T> {
  if (process.env.NODE_ENV !== "production") return load();
  const hit = hits.get(key);
  if (hit && Date.now() - hit.at < MS) return Promise.resolve(hit.value as T);
  return load().then((value) => {
    hits.set(key, { at: Date.now(), value });
    return value;
  });
}

export function forgetReadMemo() {
  hits.clear();
}
