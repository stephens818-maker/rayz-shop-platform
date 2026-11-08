/** Toasts the calendar shows when Start or Finish is tapped. */
export const SERVICE_TIME_TOAST = { start: "Started", finish: "Finished" } as const;

/** Drag-to-resize is only for a visit that hasn't started. */
export function canDragAppointment(status: string): boolean {
  return status === "booked" || status === "confirmed";
}

/**
 * The new end, in minutes from midnight, after dragging the bottom edge.
 * Snaps to 15 minutes and never ends sooner than 15 minutes after the start.
 */
export function resizeEndMin(startMin: number, endMin: number, deltaPx: number, pxPerMin: number): number {
  const raw = endMin + Math.round(deltaPx / pxPerMin);
  return Math.max(startMin + 15, Math.round(raw / 15) * 15);
}
