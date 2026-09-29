import assert from "node:assert/strict";
import test from "node:test";
import { buildApp, MAX_ROUTE_PARAM_LENGTH } from "../app.js";

test("recognize API accepts catalog slugs longer than Fastify's default", async () => {
  const app = buildApp();
  const longCatalogSlug = "catalog-item-".repeat(12);
  app.get("/__test/source/:sourceItemId", async (request) => request.params);

  try {
    assert.ok(MAX_ROUTE_PARAM_LENGTH >= 512);
    const response = await app.inject({ method: "GET", url: `/__test/source/${longCatalogSlug}` });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().sourceItemId, longCatalogSlug);
  } finally {
    await app.close();
  }
});
