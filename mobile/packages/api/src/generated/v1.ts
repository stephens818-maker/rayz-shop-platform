/**
 * Placeholder. `pnpm generate:api` needs the platform toolchain (`pnpm exec tsx` at the repo root).
 * The customer contract's OpenAPI components do not schema the new /api/v1 routes, so the app uses the hand-aligned types in `types.ts`.
 */
export interface paths {
  [pathname: string]: {
    [method in "get" | "post" | "patch" | "delete" | "put"]?: {
      parameters?: { query?: Record<string, unknown>; path?: Record<string, unknown>; header?: Record<string, unknown> };
      requestBody?: { content: { "application/json": unknown } };
      responses: { [status: number]: { content?: { "application/json": unknown } } };
    };
  };
}
