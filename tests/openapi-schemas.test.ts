import { describe, expect, it } from "vitest";
import { openApiDocument } from "@/server/openapi";

function refsOf(schema: unknown): string[] {
  if (!schema || typeof schema !== "object") return [];
  const node = schema as { $ref?: string; oneOf?: unknown[] };
  if (node.$ref) return [node.$ref.split("/").pop()!];
  if (node.oneOf) return node.oneOf.flatMap(refsOf);
  return [];
}

describe("OpenAPI schemas cover /api/v1", () => {
  const doc = openApiDocument("https://rayzbs.com");

  it("gives every operation a response schema and the request bodies a schema", () => {
    expect(doc.info.version).toBe("1.0.0");
    const requests: string[] = [];
    let operations = 0;
    for (const [path, item] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(item)) {
        if (method === "parameters" || !op || typeof op !== "object" || !("responses" in op)) continue;
        operations += 1;
        const responses = op.responses as Record<string, { content?: { "application/json"?: { schema?: unknown } } }>;
        const success = Object.keys(responses).find((code) => code.startsWith("2"));
        expect(success, path).toBeTruthy();
        if (success === "204") continue;
        const names = refsOf(responses[success!]?.content?.["application/json"]?.schema);
        expect(names.length, `${method.toUpperCase()} ${path}`).toBeGreaterThan(0);
        for (const name of names) expect(doc.components.schemas, name).toHaveProperty(name);
        const body = (op as { requestBody?: { content?: { "application/json"?: { schema?: unknown } } } }).requestBody;
        if (body?.content?.["application/json"]) {
          const bodyNames = refsOf(body.content["application/json"].schema);
          expect(bodyNames.length, `body ${method} ${path}`).toBeGreaterThan(0);
          requests.push(`${method} ${path}`);
        }
      }
    }
    const required: Record<string, string> = {
      "get /app/config": "AppConfig",
      "get /me/home": "Home",
      "get /me/family": "FamilyList",
      "post /me/family": "FamilyCreated",
      "get /me/payment-methods": "CardList",
      "post /me/payment-methods/setup": "SetupCardResponse",
      "get /me/receipts": "ReceiptList",
      "get /me/receipts/{id}": "CustomerReceipt",
      "post /appointments/{code}/payment-preview": "PaymentPreview",
      "post /appointments/{code}/payment-intents": "PaymentIntentSheet",
    };
    for (const [key, name] of Object.entries(required)) {
      const [method, path] = key.split(" ");
      const op = (doc.paths as Record<string, Record<string, { responses: Record<string, { content?: { "application/json"?: { schema?: unknown } } }> }>>)[path][method];
      const success = Object.keys(op.responses).find((code) => code.startsWith("2"))!;
      const names = refsOf(op.responses[success]?.content?.["application/json"]?.schema);
      expect(names, key).toContain(name);
      expect(success).not.toBe("204");
    }
    expect(operations).toBeGreaterThanOrEqual(22);
    expect(requests.length).toBeGreaterThanOrEqual(6);
    const text = JSON.stringify(doc);
    expect(text).not.toContain("lastInitial");
    expect(text).not.toContain("client_rating");
    expect(text).toContain("weekStartDay");
    expect(text).toContain("Credit card surcharge");
    expect(text).toContain("consentTextVersion");
    expect(text).toContain("paymentIntentId");
    expect(text).toContain("card.wallet");
  });
});
