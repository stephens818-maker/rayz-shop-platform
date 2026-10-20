import { json, route } from "@/server/api";
import { AppError } from "@/server/errors";
import { processDueJobs } from "@/server/notifications/queue";

/** Vercel Cron target (see vercel.json). Drains due confirmation/reminder jobs. */
export const GET = route(async (req) => {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get("authorization") !== `Bearer ${secret}`) throw new AppError("unauthorized", "Bad cron secret");
  return json(await processDueJobs());
});
