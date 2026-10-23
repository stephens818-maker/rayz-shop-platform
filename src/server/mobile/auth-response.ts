import { tokenResponse } from "@/server/public";

/** Turn a verify/complete result into the JSON body. Gates never include an access token. */
export async function authBody(r: {
  needsProfile?: boolean;
  chooseProfile?: boolean;
  selectionToken?: string;
  profiles?: { id: string; firstName: string }[];
  needsEmailFactor?: boolean;
  needsStepUp?: "email";
  emailHint?: string | null;
  isNew?: boolean;
  accessToken?: string;
  refreshToken?: string;
  tokenType?: "Bearer";
  expiresIn?: number;
  customer?: { id: string };
}) {
  if (r.needsProfile) return { needsProfile: true, selectionToken: r.selectionToken };
  if (r.chooseProfile) return { needsProfile: false, chooseProfile: true, selectionToken: r.selectionToken, profiles: r.profiles };
  if (r.needsEmailFactor) return { needsEmailFactor: true, selectionToken: r.selectionToken, emailHint: r.emailHint ?? null };
  if (r.needsStepUp) return { needsStepUp: r.needsStepUp, selectionToken: r.selectionToken, emailHint: r.emailHint ?? null };
  return tokenResponse(r as Parameters<typeof tokenResponse>[0]);
}
