import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Who is acting, on what device and through which channel, for the event log. Server actions open
 * one (safe), signing in fills in the staff member (authorize), and every transaction started while
 * it's open hands it to the database as rayz.event_ctx, where the event triggers read it.
 */
export interface EventContext {
  staff?: string;
  kind?: "staff" | "client" | "system";
  device?: string | null;
  channel?: string | null;
}

const store = new AsyncLocalStorage<EventContext>();

export const withEventContext = <T>(ctx: EventContext, fn: () => Promise<T>): Promise<T> => store.run(ctx, fn);

export const currentEventContext = (): EventContext | undefined => store.getStore();

/** Marks the open context as this staff member's; nothing happens outside one. */
export function setEventActor(staffId: string) {
  const c = store.getStore();
  if (!c) return;
  c.staff = staffId;
  c.kind = "staff";
  c.channel ??= "staff";
}

/** The context as the triggers read it, or null when there's nothing to say. */
export function eventContextJson(c: EventContext | undefined = store.getStore()): string | null {
  if (!c || (!c.staff && !c.device && !c.channel && !c.kind)) return null;
  return JSON.stringify({ staff: c.staff, kind: c.kind, device: c.device ?? undefined, channel: c.channel ?? undefined });
}
