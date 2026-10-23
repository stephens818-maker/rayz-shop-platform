/** Replaced by `pnpm generate:api` from the platform OpenAPI document. */
export interface paths {
  [pathname: string]: {
    [method in "get" | "post" | "patch" | "delete" | "put"]?: {
      parameters?: { query?: Record<string, unknown>; path?: Record<string, unknown>; header?: Record<string, unknown> };
      requestBody?: { content: { "application/json": unknown } };
      responses: { [status: number]: { content?: { "application/json": unknown } } };
    };
  };
}
