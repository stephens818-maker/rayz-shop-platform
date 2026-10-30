import { sql, type SQL } from "drizzle-orm";

/**
 * Not a Squire-era ticket. One that was imported, or paid with a payment the import wrote
 * (`processor = 'squire_import'`), was settled in Squire, tips included, so payroll, the tip ledger,
 * tip payouts and commission all leave it out and nothing is paid twice. `sale` is the sales row's
 * alias in the query.
 */
export function notSquireEra(sale = "s"): SQL {
  if (!/^[a-z_][a-z0-9_]*$/.test(sale)) throw new Error(`Not a table alias: ${sale}`);
  const s = sql.raw(sale);
  return sql`(not ${s}.is_imported and not exists (select 1 from payments sq where sq.sale_id = ${s}.id and sq.processor = 'squire_import'))`;
}

/** A Squire-era ticket: the complement of {@link notSquireEra}. */
export function squireEra(sale = "s"): SQL {
  return sql`(not ${notSquireEra(sale)})`;
}
