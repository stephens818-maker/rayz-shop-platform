/**
 * The status the calendar and the side panel both show. Finish records a time and leaves the
 * stored status `in_service`, because checkout still requires that. Once the service is finished,
 * both places say Finished. The row stays in_service until checkout.
 */
export function shownBookingStatus(status: string, finished: boolean): string {
  return status === "in_service" && finished ? "finished" : status;
}
