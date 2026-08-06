import assert from "node:assert/strict";
import test from "node:test";

import { DirectusError, type DirectusErrorCode } from "./directus-errors.js";
import {
  createDirectusHttpClient,
  type DirectusFetch,
} from "./directus-http-client.js";
import { createDirectusVehicleContextService } from "./directus-vehicle-context.service.js";

const FAKE_ACCESS_TOKEN = "unit-test-vehicle-token-placeholder";
const VALID_VEHICLE_ID = 14;
const VEHICLE_FIELDS = [
  "id",
  "brand_id.id",
  "brand_id.name",
  "model",
  "year",
  "mileage",
] as const;
const SENSITIVE_FIELDS = [
  "customer_id",
  "registration_number",
  "vin",
  "image",
  "appointments",
  "repairs",
  "reparations",
] as const;

const validVehicle = {
  id: VALID_VEHICLE_ID,
  model: "Unknown",
  year: null,
  mileage: 6_472,
  brand_id: {
    id: 1,
    name: "BMW",
  },
};

type VehicleHarnessOptions = {
  payload?: unknown;
  status?: number;
  timeoutMs?: number;
  fetchImplementation?: DirectusFetch;
};

const createVehicleHarness = (options: VehicleHarnessOptions = {}) => {
  const calls: Array<{ url: URL; init: RequestInit | undefined }> = [];
  const defaultFetch: DirectusFetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push({ url, init });
    return new Response(
      JSON.stringify(options.payload ?? { data: validVehicle }),
      { status: options.status ?? 200 },
    );
  };
  const fetchImplementation = options.fetchImplementation ?? defaultFetch;
  const recordingFetch: DirectusFetch =
    options.fetchImplementation === undefined
      ? fetchImplementation
      : async (input, init) => {
          const url = new URL(
            input instanceof Request ? input.url : String(input),
          );
          calls.push({ url, init });
          return fetchImplementation(input, init);
        };
  const client = createDirectusHttpClient({
    baseUrl: "https://directus.example.test/api",
    timeoutMs: options.timeoutMs ?? 1_000,
    fetchImplementation: recordingFetch,
  });

  return {
    calls,
    service: createDirectusVehicleContextService(client),
  };
};

const expectDirectusError = async (
  promise: Promise<unknown>,
  expectedCode: DirectusErrorCode,
) => {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof DirectusError);
    assert.equal(error.code, expectedCode);
    assert.equal(error.message.includes(FAKE_ACCESS_TOKEN), false);
    assert.equal(JSON.stringify(error).includes(FAKE_ACCESS_TOKEN), false);
    return true;
  });
};

const expectInvalidVehicleIdBeforeFetch = async (vehicleId: unknown) => {
  const harness = createVehicleHarness();

  await expectDirectusError(
    harness.service.getVehicleContext(FAKE_ACCESS_TOKEN, vehicleId),
    "DIRECTUS_INVALID_VEHICLE_ID",
  );
  assert.equal(harness.calls.length, 0);
};

test("returns a valid minimal vehicle context", async () => {
  const harness = createVehicleHarness();

  const result = await harness.service.getVehicleContext(
    FAKE_ACCESS_TOKEN,
    VALID_VEHICLE_ID,
  );

  assert.deepEqual(result, {
    vehicle_id: 14,
    brand: "BMW",
    model: "Unknown",
    year: null,
    mileage: 6_472,
  });
});

test("uses GET exclusively", async () => {
  const harness = createVehicleHarness();

  await harness.service.getVehicleContext(FAKE_ACCESS_TOKEN, VALID_VEHICLE_ID);

  assert.equal(harness.calls[0]?.init?.method, "GET");
});

test("requests the vehicle endpoint with the validated numeric ID", async () => {
  const harness = createVehicleHarness();

  await harness.service.getVehicleContext(FAKE_ACCESS_TOKEN, VALID_VEHICLE_ID);

  assert.equal(harness.calls[0]?.url.pathname, "/api/items/vehicles/14");
});

test("requests exactly the six authorized vehicle fields", async () => {
  const harness = createVehicleHarness();

  await harness.service.getVehicleContext(FAKE_ACCESS_TOKEN, VALID_VEHICLE_ID);

  const fields = harness.calls[0]?.url.searchParams.get("fields")?.split(",");
  assert.deepEqual(fields, VEHICLE_FIELDS);
});

test("passes the client token through the existing Authorization header", async () => {
  const harness = createVehicleHarness();

  await harness.service.getVehicleContext(FAKE_ACCESS_TOKEN, VALID_VEHICLE_ID);

  const headers = new Headers(harness.calls[0]?.init?.headers);
  assert.equal(headers.get("Authorization"), `Bearer ${FAKE_ACCESS_TOKEN}`);
});

test("never places the client token in the URL", async () => {
  const harness = createVehicleHarness();

  await harness.service.getVehicleContext(FAKE_ACCESS_TOKEN, VALID_VEHICLE_ID);

  assert.equal(harness.calls[0]?.url.href.includes(FAKE_ACCESS_TOKEN), false);
});

test("accepts a strictly positive integer vehicle ID", async () => {
  const harness = createVehicleHarness({
    payload: { data: { ...validVehicle, id: 1 } },
  });

  const result = await harness.service.getVehicleContext(FAKE_ACCESS_TOKEN, 1);

  assert.equal(result.vehicle_id, 1);
});

test("rejects a string vehicle ID before fetch", async () => {
  await expectInvalidVehicleIdBeforeFetch("14");
});

test("rejects a zero vehicle ID before fetch", async () => {
  await expectInvalidVehicleIdBeforeFetch(0);
});

test("rejects a negative vehicle ID before fetch", async () => {
  await expectInvalidVehicleIdBeforeFetch(-14);
});

test("rejects a decimal vehicle ID before fetch", async () => {
  await expectInvalidVehicleIdBeforeFetch(14.5);
});

test("rejects NaN before fetch", async () => {
  await expectInvalidVehicleIdBeforeFetch(Number.NaN);
});

test("rejects an unsafe vehicle ID before fetch", async () => {
  await expectInvalidVehicleIdBeforeFetch(Number.MAX_SAFE_INTEGER + 1);
});

test("rejects a path and query injection attempt before fetch", async () => {
  await expectInvalidVehicleIdBeforeFetch("14?fields=customer_id");
});

test("maps the relational brand to its name", async () => {
  const harness = createVehicleHarness({
    payload: {
      data: {
        ...validVehicle,
        brand_id: { id: 7, name: "  BMW  " },
      },
    },
  });

  const result = await harness.service.getVehicleContext(
    FAKE_ACCESS_TOKEN,
    VALID_VEHICLE_ID,
  );

  assert.equal(result.brand, "BMW");
  assert.equal("brand_id" in result, false);
});

test("rejects an empty brand name", async () => {
  const harness = createVehicleHarness({
    payload: {
      data: { ...validVehicle, brand_id: { id: 1, name: " " } },
    },
  });

  await expectDirectusError(
    harness.service.getVehicleContext(FAKE_ACCESS_TOKEN, VALID_VEHICLE_ID),
    "DIRECTUS_INVALID_RESPONSE",
  );
});

test("accepts a null model", async () => {
  const harness = createVehicleHarness({
    payload: { data: { ...validVehicle, model: null } },
  });

  const result = await harness.service.getVehicleContext(
    FAKE_ACCESS_TOKEN,
    VALID_VEHICLE_ID,
  );

  assert.equal(result.model, null);
});

test("accepts a null year", async () => {
  const harness = createVehicleHarness();

  const result = await harness.service.getVehicleContext(
    FAKE_ACCESS_TOKEN,
    VALID_VEHICLE_ID,
  );

  assert.equal(result.year, null);
});

test("accepts a null mileage", async () => {
  const harness = createVehicleHarness({
    payload: { data: { ...validVehicle, mileage: null } },
  });

  const result = await harness.service.getVehicleContext(
    FAKE_ACCESS_TOKEN,
    VALID_VEHICLE_ID,
  );

  assert.equal(result.mileage, null);
});

test("rejects an incoherent vehicle year", async () => {
  const harness = createVehicleHarness({
    payload: {
      data: { ...validVehicle, year: new Date().getFullYear() + 2 },
    },
  });

  await expectDirectusError(
    harness.service.getVehicleContext(FAKE_ACCESS_TOKEN, VALID_VEHICLE_ID),
    "DIRECTUS_INVALID_RESPONSE",
  );
});

test("rejects a negative mileage", async () => {
  const harness = createVehicleHarness({
    payload: { data: { ...validVehicle, mileage: -1 } },
  });

  await expectDirectusError(
    harness.service.getVehicleContext(FAKE_ACCESS_TOKEN, VALID_VEHICLE_ID),
    "DIRECTUS_INVALID_RESPONSE",
  );
});

test("rejects a vehicle ID different from the requested ID", async () => {
  const harness = createVehicleHarness({
    payload: { data: { ...validVehicle, id: 15 } },
  });

  await expectDirectusError(
    harness.service.getVehicleContext(FAKE_ACCESS_TOKEN, VALID_VEHICLE_ID),
    "DIRECTUS_INVALID_RESPONSE",
  );
});

test("rejects a response without data", async () => {
  const harness = createVehicleHarness({ payload: {} });

  await expectDirectusError(
    harness.service.getVehicleContext(FAKE_ACCESS_TOKEN, VALID_VEHICLE_ID),
    "DIRECTUS_INVALID_RESPONSE",
  );
});

test("rejects an invalid response with additional fields", async () => {
  const harness = createVehicleHarness({
    payload: { data: { ...validVehicle, customer_id: 99 } },
  });

  await expectDirectusError(
    harness.service.getVehicleContext(FAKE_ACCESS_TOKEN, VALID_VEHICLE_ID),
    "DIRECTUS_INVALID_RESPONSE",
  );
});

test("preserves the controlled 401 error", async () => {
  const harness = createVehicleHarness({ status: 401 });

  await expectDirectusError(
    harness.service.getVehicleContext(FAKE_ACCESS_TOKEN, VALID_VEHICLE_ID),
    "DIRECTUS_UNAUTHORIZED",
  );
});

test("maps a 403 to the generic inaccessible vehicle error", async () => {
  const harness = createVehicleHarness({ status: 403 });

  await expectDirectusError(
    harness.service.getVehicleContext(FAKE_ACCESS_TOKEN, VALID_VEHICLE_ID),
    "DIRECTUS_VEHICLE_NOT_ACCESSIBLE",
  );
});

test("maps a 404 to the same generic inaccessible vehicle error", async () => {
  const harness = createVehicleHarness({ status: 404 });

  await expectDirectusError(
    harness.service.getVehicleContext(FAKE_ACCESS_TOKEN, VALID_VEHICLE_ID),
    "DIRECTUS_VEHICLE_NOT_ACCESSIBLE",
  );
});

test("maps a timed-out request to the existing timeout error", async () => {
  const fetchImplementation: DirectusFetch = async (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(new DOMException("Aborted", "AbortError"));
      });
    });
  const harness = createVehicleHarness({
    fetchImplementation,
    timeoutMs: 5,
  });

  await expectDirectusError(
    harness.service.getVehicleContext(FAKE_ACCESS_TOKEN, VALID_VEHICLE_ID),
    "DIRECTUS_TIMEOUT",
  );
});

test("maps a network failure without exposing its details", async () => {
  const fetchImplementation: DirectusFetch = async () => {
    throw new Error(`network failure ${FAKE_ACCESS_TOKEN}`);
  };
  const harness = createVehicleHarness({ fetchImplementation });

  await expectDirectusError(
    harness.service.getVehicleContext(FAKE_ACCESS_TOKEN, VALID_VEHICLE_ID),
    "DIRECTUS_UNAVAILABLE",
  );
});

test("rejects a missing client token before fetch", async () => {
  const harness = createVehicleHarness();

  await expectDirectusError(
    harness.service.getVehicleContext("", VALID_VEHICLE_ID),
    "DIRECTUS_UNAUTHORIZED",
  );
  assert.equal(harness.calls.length, 0);
});

test("excludes every sensitive field from the URL and result", async () => {
  const harness = createVehicleHarness();

  const result = await harness.service.getVehicleContext(
    FAKE_ACCESS_TOKEN,
    VALID_VEHICLE_ID,
  );
  const url = harness.calls[0]?.url.href ?? "";
  const serializedResult = JSON.stringify(result);

  for (const sensitiveField of SENSITIVE_FIELDS) {
    assert.equal(url.includes(sensitiveField), false);
    assert.equal(serializedResult.includes(sensitiveField), false);
  }
  assert.deepEqual(Object.keys(result).sort(), [
    "brand",
    "mileage",
    "model",
    "vehicle_id",
    "year",
  ]);
});

test("exposes no POST, PATCH, or DELETE operation", () => {
  const harness = createVehicleHarness();

  assert.deepEqual(Object.keys(harness.service), ["getVehicleContext"]);
  assert.equal("post" in harness.service, false);
  assert.equal("patch" in harness.service, false);
  assert.equal("delete" in harness.service, false);
});
