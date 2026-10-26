/** Sign-out drops cached profiles, receipts, and earnings along with the token. */
export function signOutSession(queryClient: { clear: () => void }, clearSession: () => Promise<void>): Promise<void> {
  queryClient.clear();
  return clearSession();
}
