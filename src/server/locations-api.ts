import "server-only";
import { z } from "zod";
import { LOCATIONS_OPENAPI, LocationQuerySchema } from "@/domain/location-profile";
import { appBaseUrl } from "@/lib/deployment";
import { json, options, query, route } from "./api";
import { publicLocation, publicLocations } from "./public-locations";

/**
 * The public locations API, no sign-in: mounted at /api/locations here for the website widget, and
 * ready for the mobile app's /api/v1/locations (LOCATIONS_OPENAPI in src/domain/location-profile.ts).
 * Responses may be cached for a minute at the edge: nothing in them is about a client.
 */
const CACHE = { "Cache-Control": "public, max-age=60, s-maxage=60, stale-while-revalidate=300" };

function parse(req: Request) {
  const q = query(req, LocationQuerySchema);
  const [lat, lng] = q.near ? q.near.split(",").map(Number) : [];
  return { near: q.near ? { lat, lng } : null, zip: q.zip ?? null, radiusMiles: q.radius ?? null, serviceId: q.serviceId ?? null };
}

/** GET /locations */
export const getLocations = route(async (req) => json({ locations: await publicLocations(parse(req)) }, 200, CACHE));

/** GET /locations/{slug} */
export const getLocation = route<{ slug: string }>(async (req, params) => {
  const { slug } = z.object({ slug: z.string().min(1).max(60) }).parse(params);
  return json(await publicLocation(slug, { serviceId: parse(req).serviceId }), 200, CACHE);
});

/** GET /locations/openapi.json: this API on its own, until it joins the v1 document. */
export const getLocationsOpenApi = route(async () => {
  const schema = (s: z.ZodType) => z.toJSONSchema(s, { unrepresentable: "any", io: "output" });
  return json(
    {
      openapi: "3.1.0",
      info: { title: "Ray'z Barber Shop: locations", version: "1.0.0", description: "Public, no sign-in. Addresses, map pins, phone numbers, hours, open now and the next open slot, for the booking widget and the app." },
      servers: [{ url: `${appBaseUrl()}/api` }],
      components: {
        schemas: {
          ...Object.fromEntries(Object.entries(LOCATIONS_OPENAPI.components).map(([k, v]) => [k, schema(v)])),
          Error: { type: "object", properties: { error: { type: "object", properties: { code: { type: "string" }, message: { type: "string" }, details: {} }, required: ["code", "message"] } }, required: ["error"] },
        },
      },
      paths: LOCATIONS_OPENAPI.paths,
    },
    200,
    CACHE,
  );
});

export const OPTIONS = options;
