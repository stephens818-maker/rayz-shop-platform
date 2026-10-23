/** A new sign-in drops any step-up token from the previous person. */
export function signedInSession(next: { token: string; refreshToken: string; firstName: string; staffId: string }) {
  return { session: next, unlocked: false as const, stepUp: null as null };
}
