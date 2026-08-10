import assert from "node:assert/strict";
import test from "node:test";

import { DirectusError } from "./directus-errors.js";
import { createDirectusBookingVehicleService } from "./directus-booking-vehicle.service.js";
import type { DirectusReadClient } from "./directus-http-client.js";

const CLIENT_TOKEN = "unit-test-client-token-placeholder";

test("derives the customer identity from the vehicle read with the client token", async () => {
  const calls: Array<{
    endpoint: string;
    params: URLSearchParams;
    accessToken: string;
  }> = [];
  const client: DirectusReadClient = {
    async getJson(endpoint, params, accessToken) {
      calls.push({ endpoint, params: new URLSearchParams(params), accessToken });
      return {
        data: {
          id: 14,
          customer_id: { id: 55 },
          brand_id: { name: "BMW" },
          model: "Unknown",
        },
      };
    },
  };

  const result = await createDirectusBookingVehicleService(
    client,
  ).getBookingVehicleIdentity(CLIENT_TOKEN, 14);

  assert.deepEqual(result, { vehicleId: 14, customerId: 55, label: "BMW" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.endpoint, "/items/vehicles/14");
  assert.equal(
    calls[0]?.params.get("fields"),
    "id,customer_id,brand_id.name,model",
  );
  assert.equal(calls[0]?.accessToken, CLIENT_TOKEN);
  assert.equal(JSON.stringify(result).includes(CLIENT_TOKEN), false);
});

test("accepts a numeric customer relation and preserves a known model", async () => {
  const client: DirectusReadClient = {
    async getJson() {
      return {
        data: {
          id: 14,
          customer_id: 55,
          brand_id: { name: "BMW" },
          model: "X1",
        },
      };
    },
  };

  const result = await createDirectusBookingVehicleService(
    client,
  ).getBookingVehicleIdentity(CLIENT_TOKEN, 14);
  assert.deepEqual(result, {
    vehicleId: 14,
    customerId: 55,
    label: "BMW X1",
  });
});

test("maps forbidden and missing vehicles to the controlled inaccessible error", async () => {
  for (const code of ["DIRECTUS_FORBIDDEN", "DIRECTUS_NOT_FOUND"] as const) {
    const client: DirectusReadClient = {
      async getJson() {
        throw new DirectusError(code);
      },
    };

    await assert.rejects(
      createDirectusBookingVehicleService(client).getBookingVehicleIdentity(
        CLIENT_TOKEN,
        14,
      ),
      (error: unknown) =>
        error instanceof DirectusError &&
        error.code === "DIRECTUS_VEHICLE_NOT_ACCESSIBLE",
    );
  }
});

test("rejects invalid Directus vehicle data without exposing it", async () => {
  const client: DirectusReadClient = {
    async getJson() {
      return {
        data: {
          id: 14,
          customer_id: null,
          brand_id: { name: "BMW" },
          model: "X1",
          registration_number: "forbidden-test-value",
        },
      };
    },
  };

  await assert.rejects(
    createDirectusBookingVehicleService(client).getBookingVehicleIdentity(
      CLIENT_TOKEN,
      14,
    ),
    (error: unknown) =>
      error instanceof DirectusError &&
      error.code === "DIRECTUS_INVALID_RESPONSE",
  );
});
