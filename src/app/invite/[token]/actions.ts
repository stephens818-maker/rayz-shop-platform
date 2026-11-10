"use server";

import { z } from "zod";
import { safe } from "@/server/action";
import { AppError } from "@/server/errors";
import { acceptInvite } from "@/server/users";

const AcceptSchema = z.object({
  token: z.string().min(20).max(100),
  password: z.string().max(200),
  confirm: z.string().max(200),
  sealed: z.string().max(500).nullable().default(null),
  code: z.string().max(10).nullable().default(null),
});

/** Sets the password (and authenticator, when required) for an invited user. The link works once. */
export async function acceptInviteAction(raw: z.input<typeof AcceptSchema>) {
  return safe(async () => {
    const p = AcceptSchema.parse(raw);
    if (p.password !== p.confirm) throw new AppError("bad_request", "The passwords don't match");
    return acceptInvite(p);
  });
}
