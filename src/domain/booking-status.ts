/**
 * The status the calendar and the side panel both show. Finish records a time and leaves the
 * stored status `in_service`, because checkout still requires that. Once the service is finished,
 * both places say Finished. The row stays in_service until checkout.
 */
export function shownBookingStatus(status: string, finished: boolean): string {
  return status === "in_service" && finished ? "finished" : status;
}

/**
 * Clear visit is how a voided ticket leaves the book while the visit is still Checked in, In chair,
 * or Finished. A voided visit that is already cancelled is not restored back onto the day.
 */
export function clearVisitOffered(status: string, finished: boolean, ticketVoided: boolean): boolean {
  if (!ticketVoided) return false;
  const shown = shownBookingStatus(status, finished);
  return shown === "checked_in" || shown === "in_service" || shown === "finished" || status === "completed";
}

export function restoreOffered(status: string, ticketVoided: boolean): boolean {
  return (status === "cancelled" || status === "no_show") && !ticketVoided;
}
