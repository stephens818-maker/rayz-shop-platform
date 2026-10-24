/**
 * Load zip code centers for "within N miles of a location" filters.
 *
 *   curl -O https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2024_Gazetteer/2024_Gaz_zcta_national.zip
 *   unzip 2024_Gaz_zcta_national.zip
 *   pnpm tsx scripts/load-zip-points.ts 2024_Gaz_zcta_national.txt
 *
 * The file is tab separated with GEOID (the zip), INTPTLAT and INTPTLONG columns. Re-running
 * updates existing rows. Without it, distance filters only work for shops that have their own
 * latitude and longitude and clients in zips already loaded.
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import postgres from "postgres";

async function main() {
  const path = process.argv[2];
  if (!path) throw new Error("Pass the path to the Census ZCTA gazetteer .txt file");
  const [header, ...lines] = readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean);
  const cols = header.split("\t").map((c) => c.trim().toUpperCase());
  const at = (name: string) => {
    const i = cols.indexOf(name);
    if (i < 0) throw new Error(`Column ${name} not found; is this the ZCTA gazetteer file?`);
    return i;
  };
  const [zi, lati, lngi] = [at("GEOID"), at("INTPTLAT"), at("INTPTLONG")];
  const rows = lines
    .map((l) => l.split("\t"))
    .map((f) => ({ zip: f[zi]?.trim(), lat: Number(f[lati]), lng: Number(f[lngi]) }))
    .filter((r) => /^\d{5}$/.test(r.zip ?? "") && Number.isFinite(r.lat) && Number.isFinite(r.lng) && Math.abs(r.lat) <= 90 && Math.abs(r.lng) <= 180);

  const url = process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  for (let i = 0; i < rows.length; i += 2000) {
    const chunk = rows.slice(i, i + 2000);
    await sql`insert into zip_points ${sql(chunk, "zip", "lat", "lng")}
      on conflict (zip) do update set lat = excluded.lat, lng = excluded.lng`;
  }
  await sql.end();
  console.log(`Loaded ${rows.length} zip centers.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
