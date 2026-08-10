import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import type { Express } from "express";

import { createApp } from "../app.js";
import {
  BookingAvailabilityError,
  type SearchAppointmentAvailabilityUseCase,
} from "../application/ai-booking/index.js";
import { createAppointmentAvailabilityRequestSchema } from "../domain/ai-booking/index.js";
import { createAiRateLimiter } from "../middleware/ai-rate-limit.js";

const CLIENT_TOKEN = "unit-test-client-token-placeholder";

const availability = {
  preferred_date_available: true,
  options: [
    {
      workshop_id: 1 as const,
      workshop_name: "Atelier Rapide",
      showroom: {
        id: 1,
        name: "Moulay Slimane",
        address: "Adresse test",
        city: "Casablanca",
        phone: "0000000000",
      },
      requested_date: "2026-08-12",
      requested_time: "09:30:00",
      slot_interval_minutes: 30,
      label: "Atelier Rapide — 12/08/2026 à 09:30",
    },
  ],
};

const validBody = {
  service_type_id: 2,
  workshop_ids: [1],
  preferred_date: "2026-08-12",
  preferred_period: "morning",
};

const withServer = async <T>(
  application: Express,
  run: (baseUrl: string) => Promise<T>,
) => {
  const server = createServer(application);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;

  try {
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
  }
};

const postAvailability = (
  baseUrl: string,
  body: unknown,
  authorization = `Bearer ${CLIENT_TOKEN}`,
) =>
  fetch(`${baseUrl}/api/ai/appointments/availability`, {
    method: "POST",
    headers: {
      Authorization: authorization,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

const createHarness = (
  searchOverride?: SearchAppointmentAvailabilityUseCase,
  limit = 5,
) => {
  const calls: Array<{ accessToken: string; body: unknown }> = [];
  let diagnosticCalls = 0;
  const searchAppointmentAvailability: SearchAppointmentAvailabilityUseCase =
    searchOverride ??
    (async (accessToken, body) => {
      createAppointmentAvailabilityRequestSchema("2026-08-10").parse(body);
      calls.push({ accessToken, body });
      return availability;
    });
  const application = createApp({
    analyzeDiagnostic: async () => {
      diagnosticCalls += 1;
      throw new Error("Diagnostic must not be called by booking tests.");
    },
    searchAppointmentAvailability,
    bookingRateLimiter: createAiRateLimiter({ limit }),
  });
  return { application, calls, getDiagnosticCalls: () => diagnosticCalls };
};

test("returns only the secure deterministic availability result", async () => {
  const harness = createHarness();
  await withServer(harness.application, async (baseUrl) => {
    const response = await postAvailability(baseUrl, validBody);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.deepEqual(payload, { data: availability });
    assert.equal(JSON.stringify(payload).includes(CLIENT_TOKEN), false);
    for (const forbidden of ["capacity", "resources", "appointments", "status"]) {
      assert.equal(
        JSON.stringify(payload).toLowerCase().includes(forbidden),
        false,
      );
    }
  });
  assert.deepEqual(harness.calls, [
    { accessToken: CLIENT_TOKEN, body: validBody },
  ]);
  assert.equal(harness.getDiagnosticCalls(), 0);
});

test("requires the existing Bearer authentication", async () => {
  const harness = createHarness();
  await withServer(harness.application, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/ai/appointments/availability`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validBody),
      },
    );
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), {
      error: {
        code: "AUTHORIZATION_REQUIRED",
        message: "A valid Bearer authorization header is required.",
      },
    });
  });
  assert.equal(harness.calls.length, 0);
});

test("maps strict validation and no-availability errors", async () => {
  const validationHarness = createHarness();
  await withServer(validationHarness.application, async (baseUrl) => {
    const response = await postAvailability(baseUrl, {
      ...validBody,
      customer_id: 99,
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, "INVALID_REQUEST");
  });

  const unavailableHarness = createHarness(async () => {
    throw new BookingAvailabilityError("BOOKING_AVAILABILITY_NOT_FOUND");
  });
  await withServer(unavailableHarness.application, async (baseUrl) => {
    const response = await postAvailability(baseUrl, validBody);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), {
      error: {
        code: "BOOKING_AVAILABILITY_NOT_FOUND",
        message: "No compatible appointment availability was found.",
      },
    });
  });
});

test("rate limits availability independently with a controlled error", async () => {
  const harness = createHarness(undefined, 1);
  await withServer(harness.application, async (baseUrl) => {
    assert.equal((await postAvailability(baseUrl, validBody)).status, 200);
    const response = await postAvailability(baseUrl, validBody);
    assert.equal(response.status, 429);
    assert.equal(response.headers.has("Retry-After"), true);
    assert.equal((await response.json()).error.code, "BOOKING_RATE_LIMIT_EXCEEDED");
  });
  assert.equal(harness.calls.length, 1);
});

test("does not expose a creation endpoint", async () => {
  const harness = createHarness();
  await withServer(harness.application, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/ai/appointments/confirm`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${CLIENT_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });
    assert.equal(response.status, 404);
  });
});
