import assert from "node:assert/strict";
import test from "node:test";

import { createDirectusAppointmentWriteClient } from "./directus-appointment-write-client.js";
import { DirectusError } from "./directus-errors.js";
import type { DirectusFetch } from "./directus-http-client.js";

const CLIENT_TOKEN = "unit-test-client-token-placeholder";
const validInput = {
  customer_id: 55,
  vehicle_id: 14,
  service_type_id: 2 as const,
  workshop_id: 20,
  requested_date: "2026-08-12",
  requested_time: "09:30:00",
  comment: "Le voyant moteur reste allume.",
};

const jsonResponse = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });

test("creates exactly one pending appointment with the client Bearer token", async () => {
  let capturedUrl: URL | undefined;
  let capturedInit: RequestInit | undefined;
  let callCount = 0;
  const fetchImplementation: DirectusFetch = async (input, init) => {
    callCount += 1;
    capturedUrl = new URL(input instanceof Request ? input.url : String(input));
    capturedInit = init;
    return jsonResponse({ data: { id: 123, status: "pending" } });
  };
  const client = createDirectusAppointmentWriteClient({
    baseUrl: "https://directus.example.test/directus",
    timeoutMs: 1_000,
    fetchImplementation,
  });

  const result = await client.createAppointment(CLIENT_TOKEN, validInput);

  assert.deepEqual(Object.keys(client), ["createAppointment"]);
  assert.equal(callCount, 1);
  assert.equal(capturedUrl?.pathname, "/directus/items/appointments");
  assert.equal(capturedUrl?.searchParams.get("fields"), "id,status");
  assert.equal(capturedUrl?.toString().includes(CLIENT_TOKEN), false);
  assert.equal(capturedInit?.method, "POST");
  const headers = new Headers(capturedInit?.headers);
  assert.equal(headers.get("Authorization"), `Bearer ${CLIENT_TOKEN}`);
  assert.deepEqual(JSON.parse(String(capturedInit?.body)), validInput);
  for (const forbidden of [
    "status",
    "showroom_id",
    "arrival_confirmed_at",
    "cancellation_reason",
    "repairs",
    "token",
    "Idempotency-Key",
  ]) {
    assert.equal(
      Object.hasOwn(JSON.parse(String(capturedInit?.body)), forbidden),
      false,
    );
  }
  assert.deepEqual(result, { appointmentId: 123, status: "pending" });
});

test("refuses status and showroom fields before any request", async () => {
  let calls = 0;
  const client = createDirectusAppointmentWriteClient({
    baseUrl: "http://localhost:8055",
    timeoutMs: 1_000,
    fetchImplementation: async () => {
      calls += 1;
      return jsonResponse({ data: { id: 123, status: "pending" } });
    },
  });

  for (const extraInput of [
    { ...validInput, status: "confirmed" },
    { ...validInput, showroom_id: 8 },
  ]) {
    await assert.rejects(
      client.createAppointment(CLIENT_TOKEN, extraInput as never),
    );
  }
  assert.equal(calls, 0);
});

test("rejects a Directus response whose status is not pending", async () => {
  const client = createDirectusAppointmentWriteClient({
    baseUrl: "http://localhost:8055",
    timeoutMs: 1_000,
    fetchImplementation: async () =>
      jsonResponse({ data: { id: 123, status: "confirmed" } }),
  });

  await assert.rejects(
    client.createAppointment(CLIENT_TOKEN, validInput),
    (error: unknown) =>
      error instanceof DirectusError &&
      error.code === "DIRECTUS_INVALID_RESPONSE",
  );
});

test("maps a rejected Directus POST without exposing the token", async () => {
  const client = createDirectusAppointmentWriteClient({
    baseUrl: "http://localhost:8055",
    timeoutMs: 1_000,
    fetchImplementation: async () => jsonResponse({}, 403),
  });

  await assert.rejects(
    client.createAppointment(CLIENT_TOKEN, validInput),
    (error: unknown) => {
      assert.ok(error instanceof DirectusError);
      assert.equal(error.code, "DIRECTUS_FORBIDDEN");
      assert.equal(JSON.stringify(error).includes(CLIENT_TOKEN), false);
      return true;
    },
  );
});
