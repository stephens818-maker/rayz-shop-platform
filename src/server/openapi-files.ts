import { openApiDocument } from "./openapi";
import { staffOpenApiDocument } from "./staff-api/openapi";

/** The server the committed documents name; the apps set their own base URL at run time. */
export const OPENAPI_BASE_URL = "https://api.rayzbs.com";

/** openapi/v1.json (customer app) and openapi/staff-v1.json (staff app), as committed. */
export const openApiFiles = (baseUrl: string) => ({
  "v1.json": `${JSON.stringify(openApiDocument(baseUrl), null, 2)}\n`,
  "staff-v1.json": `${JSON.stringify(staffOpenApiDocument(baseUrl), null, 2)}\n`,
});
