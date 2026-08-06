import assert from "node:assert/strict";
import test from "node:test";

import { DirectusError } from "./directus-errors.js";
import {
  createDirectusHttpClient,
  type DirectusFetch,
} from "./directus-http-client.js";

const FAKE_ACCESS_TOKEN = "unit-test-directus-token-placeholder";

const toUrl = (input: string | URL | Request) =>
  new URL(input instanceof Request ? input.url : String(input));

const jsonResponse = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const expectDirectusError = async (
  promise: Promise<unknown>,
  expectedCode: DirectusError["code"],
) => {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof DirectusError);
    assert.equal(error.code, expectedCode);
    assert.equal(error.message.includes(FAKE_ACCESS_TOKEN), false);
    assert.equal(JSON.stringify(error).includes(FAKE_ACCESS_TOKEN), false);
    return true;
  });
};

test("uses DIRECTUS_URL, GET, the requested endpoint, and JSON headers", async () => {
  let capturedUrl: URL | undefined;
  let capturedInit: RequestInit | undefined;
  const fetchImplementation: DirectusFetch = async (input, init) => {
    capturedUrl = toUrl(input);
    capturedInit = init;
    return jsonResponse({ data: [] });
  };
  const client = createDirectusHttpClient({
    baseUrl: "https://directus.example.test:8443/directus",
    timeoutMs: 1_000,
    fetchImplementation,
  });

  await client.getJson(
    "/items/service_types",
    new URLSearchParams({ fields: "id,name,qualification_code" }),
    FAKE_ACCESS_TOKEN,
  );

  assert.equal(capturedUrl?.origin, "https://directus.example.test:8443");
  assert.equal(capturedUrl?.pathname, "/directus/items/service_types");
  assert.equal(
    capturedUrl?.searchParams.get("fields"),
    "id,name,qualification_code",
  );
  assert.equal(capturedInit?.method, "GET");
  const headers = new Headers(capturedInit?.headers);
  assert.equal(headers.get("Accept"), "application/json");
  assert.equal(headers.get("Authorization"), `Bearer ${FAKE_ACCESS_TOKEN}`);
});

test("never places the access token in the URL", async () => {
  let capturedUrl = "";
  const fetchImplementation: DirectusFetch = async (input) => {
    capturedUrl = String(input);
    return jsonResponse({ data: [] });
  };
  const client = createDirectusHttpClient({
    baseUrl: "http://localhost:8055",
    timeoutMs: 1_000,
    fetchImplementation,
  });

  await client.getJson(
    "/items/workshops",
    new URLSearchParams(),
    FAKE_ACCESS_TOKEN,
  );

  assert.equal(capturedUrl.includes(FAKE_ACCESS_TOKEN), false);
});

test("returns decoded JSON rather than a raw Response", async () => {
  const payload = { data: [{ id: 2 }] };
  const client = createDirectusHttpClient({
    baseUrl: "http://localhost:8055",
    timeoutMs: 1_000,
    fetchImplementation: async () => jsonResponse(payload),
  });

  const result = await client.getJson(
    "/items/service_types",
    new URLSearchParams(),
    FAKE_ACCESS_TOKEN,
  );

  assert.deepEqual(result, payload);
  assert.equal(result instanceof Response, false);
});

test("maps invalid JSON to DIRECTUS_INVALID_RESPONSE", async () => {
  const client = createDirectusHttpClient({
    baseUrl: "http://localhost:8055",
    timeoutMs: 1_000,
    fetchImplementation: async () =>
      new Response("not-json", { status: 200 }),
  });

  await expectDirectusError(
    client.getJson(
      "/items/service_types",
      new URLSearchParams(),
      FAKE_ACCESS_TOKEN,
    ),
    "DIRECTUS_INVALID_RESPONSE",
  );
});

test("maps HTTP 401 to DIRECTUS_UNAUTHORIZED", async () => {
  const client = createDirectusHttpClient({
    baseUrl: "http://localhost:8055",
    timeoutMs: 1_000,
    fetchImplementation: async () =>
      new Response("sensitive raw body", { status: 401 }),
  });

  await expectDirectusError(
    client.getJson(
      "/items/service_types",
      new URLSearchParams(),
      FAKE_ACCESS_TOKEN,
    ),
    "DIRECTUS_UNAUTHORIZED",
  );
});

test("maps HTTP 403 to DIRECTUS_FORBIDDEN", async () => {
  const client = createDirectusHttpClient({
    baseUrl: "http://localhost:8055",
    timeoutMs: 1_000,
    fetchImplementation: async () =>
      new Response("<html>forbidden</html>", { status: 403 }),
  });

  await expectDirectusError(
    client.getJson(
      "/items/service_types",
      new URLSearchParams(),
      FAKE_ACCESS_TOKEN,
    ),
    "DIRECTUS_FORBIDDEN",
  );
});

test("maps HTTP 500 to DIRECTUS_ERROR without exposing its body", async () => {
  const rawBody = "private upstream failure details";
  const client = createDirectusHttpClient({
    baseUrl: "http://localhost:8055",
    timeoutMs: 1_000,
    fetchImplementation: async () => new Response(rawBody, { status: 500 }),
  });

  await assert.rejects(
    client.getJson(
      "/items/service_types",
      new URLSearchParams(),
      FAKE_ACCESS_TOKEN,
    ),
    (error: unknown) => {
      assert.ok(error instanceof DirectusError);
      assert.equal(error.code, "DIRECTUS_ERROR");
      assert.equal(error.message.includes(rawBody), false);
      return true;
    },
  );
});

test("maps network failures to DIRECTUS_UNAVAILABLE", async () => {
  const client = createDirectusHttpClient({
    baseUrl: "http://localhost:8055",
    timeoutMs: 1_000,
    fetchImplementation: async () => {
      throw new Error(`network failure ${FAKE_ACCESS_TOKEN}`);
    },
  });

  await expectDirectusError(
    client.getJson(
      "/items/service_types",
      new URLSearchParams(),
      FAKE_ACCESS_TOKEN,
    ),
    "DIRECTUS_UNAVAILABLE",
  );
});

test("aborts timed-out requests and maps them to DIRECTUS_TIMEOUT", async () => {
  let receivedSignal: AbortSignal | undefined;
  const fetchImplementation: DirectusFetch = async (_input, init) => {
    receivedSignal = init?.signal ?? undefined;
    return new Promise<Response>((_resolve, reject) => {
      receivedSignal?.addEventListener("abort", () => {
        reject(new DOMException("Aborted", "AbortError"));
      });
    });
  };
  const client = createDirectusHttpClient({
    baseUrl: "http://localhost:8055",
    timeoutMs: 5,
    fetchImplementation,
  });

  await expectDirectusError(
    client.getJson(
      "/items/service_types",
      new URLSearchParams(),
      FAKE_ACCESS_TOKEN,
    ),
    "DIRECTUS_TIMEOUT",
  );
  assert.equal(receivedSignal?.aborted, true);
});

test("rejects a missing access token before fetch", async () => {
  let called = false;
  const client = createDirectusHttpClient({
    baseUrl: "http://localhost:8055",
    timeoutMs: 1_000,
    fetchImplementation: async () => {
      called = true;
      return jsonResponse({ data: [] });
    },
  });

  await expectDirectusError(
    client.getJson("/items/service_types", new URLSearchParams(), ""),
    "DIRECTUS_UNAUTHORIZED",
  );
  assert.equal(called, false);
});

test("rejects endpoints outside the read-only items integration", async () => {
  let called = false;
  const client = createDirectusHttpClient({
    baseUrl: "http://localhost:8055",
    timeoutMs: 1_000,
    fetchImplementation: async () => {
      called = true;
      return jsonResponse({ data: [] });
    },
  });

  await expectDirectusError(
    client.getJson("/users", new URLSearchParams(), FAKE_ACCESS_TOKEN),
    "DIRECTUS_ERROR",
  );
  assert.equal(called, false);
});

test("exposes no POST, PATCH, or DELETE operation", () => {
  const client = createDirectusHttpClient({
    baseUrl: "http://localhost:8055",
    timeoutMs: 1_000,
    fetchImplementation: async () => jsonResponse({ data: [] }),
  });

  assert.deepEqual(Object.keys(client), ["getJson"]);
  assert.equal("post" in client, false);
  assert.equal("patch" in client, false);
  assert.equal("delete" in client, false);
});
