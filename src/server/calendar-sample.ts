import { sql } from "drizzle-orm";
import { appointments } from "@/db/schema";

/**
 * The book shows real visits. Seeded sample rows stay off it, including in the sandbox.
 * A Zzcanary canary is marked on purpose and still shows.
 */
export const bookedForReal = sql`(${appointments.sample} = false or exists (select 1 from customers zc where zc.id = ${appointments.customerId} and lower(zc.last_name) = 'zzcanary'))`;
