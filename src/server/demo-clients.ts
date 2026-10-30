import { eq, sql, type SQL } from "drizzle-orm";
import { customers } from "@/db/schema";

/** ST-I19: the Demo Shop's clients carry this source. Only its app reviewer ever sees them. */
export const DEMO_CLIENT_SOURCE = "Demo Shop";

/** Real clients only. `source` is the customers source column; raw SQL passes its alias's (c.source). */
export const realClient = (source: SQL | typeof customers.source = customers.source) => sql`${source} is distinct from ${DEMO_CLIENT_SOURCE}`;

/** The clients a list shows this person: demo clients to the Demo Shop's reviewer, real ones to everyone else. */
export const clientsFor = (demo: boolean | undefined) => (demo ? eq(customers.source, DEMO_CLIENT_SOURCE) : realClient());
