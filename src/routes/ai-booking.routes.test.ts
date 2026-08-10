import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import type { Express } from "express";

import { createApp } from "../app.js";
import {
  BookingAvailabilityError,
  BookingConfirmationError,
  type ConfirmAppointmentUseCase,
  type SearchAppointmentAvailabilityUseCase,
} from "../application/ai-booking/index.js";
import { createAppointmentAvailabilityRequestSchema } from "../domain/ai-booking/index.js";
import { DirectusError } from "../infrastructure/directus/index.js";
import { createAiRateLimiter } from "../middleware/ai-rate-limit.js";

const CLIENT_TOKEN = "unit-test-client-token-placeholder";

const availability = {
  preferred_date_available: true,
  options: [
    {
      slot_token: "unit-test-slot-token-placeholder",
      expires_at: "2026-08-10T12:10:00.000Z",
      service_type: {
        id: 2 as const,
        name: "Diagnostic",
      },
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
  vehicle_id: 14,
  service_type_id: 2,
  workshop_ids: [1],
  preferred_date: "2026-08-12",
  preferred_period: "morning",
};

const confirmationResult = {
  appointment_id: 123,
  status: "pending" as const,
  vehicle: { id: 14, label: "BMW X1" },
  service_type: { id: 2 as const, name: "Diagnostic" },
  workshop: { id: 1 as const, name: "Atelier Rapide" },
  showroom: {
    id: 1,
    name: "Moulay Slimane",
    address: "Adresse test",
    city: "Casablanca",
    phone: "0000000000",
  },
  requested_date: "2026-08-12",
  requested_time: "09:30:00",
  problem_summary: "Le voyant moteur reste allume.",
};

const validConfirmationBody = {
  slot_token: "unit-test-slot-token-placeholder",
  problem_summary: "Le voyant moteur reste allume.",
  confirmation: true,
};

const IDEMPOTENCY_KEY = "00000000-0000-4000-8000-000000000001";

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
    confirmAppointment: async () => {
      throw new Error("Confirmation must not be called by availability tests.");
    },
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

test("maps an inaccessible vehicle to the controlled 404 response", async () => {
  const harness = createHarness(async () => {
    throw new DirectusError("DIRECTUS_VEHICLE_NOT_ACCESSIBLE");
  });
  await withServer(harness.application, async (baseUrl) => {
    const response = await postAvailability(baseUrl, validBody);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), {
      error: {
        code: "DIRECTUS_VEHICLE_NOT_ACCESSIBLE",
        message: "The vehicle is not accessible.",
      },
    });
  });
});

test("maps a missing slot-token secret to a controlled configuration error", async () => {
  const harness = createHarness(async () => {
    throw new BookingAvailabilityError("BOOKING_CONFIGURATION_ERROR");
  });
  await withServer(harness.application, async (baseUrl) => {
    const response = await postAvailability(baseUrl, validBody);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      error: {
        code: "BOOKING_CONFIGURATION_ERROR",
        message: "Appointment booking is not configured.",
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

const createConfirmationHarness = (
  confirmOverride?: ConfirmAppointmentUseCase,
) => {
  const calls: Array<{
    accessToken: string;
    idempotencyKey: unknown;
    body: unknown;
  }> = [];
  const confirmAppointment: ConfirmAppointmentUseCase =
    confirmOverride ??
    (async (accessToken, idempotencyKey, body) => {
      calls.push({ accessToken, idempotencyKey, body });
      return confirmationResult;
    });
  const application = createApp({
    analyzeDiagnostic: async () => {
      throw new Error("Diagnostic must not be called by confirmation tests.");
    },
    searchAppointmentAvailability: async () => {
      throw new Error("Availability must not be called by confirmation tests.");
    },
    confirmAppointment,
    bookingRateLimiter: createAiRateLimiter({ limit: 20 }),
  });
  return { application, calls };
};

const postConfirmation = (
  baseUrl: string,
  body: unknown,
  idempotencyKey: string | null = IDEMPOTENCY_KEY,
) => {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${CLIENT_TOKEN}`,
    "Content-Type": "application/json",
  };
  if (idempotencyKey !== null) {
    headers["Idempotency-Key"] = idempotencyKey;
  }
  return fetch(`${baseUrl}/api/ai/appointments/confirm`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
};

test("returns only the filtered pending confirmation", async () => {
  const harness = createConfirmationHarness();
  await withServer(harness.application, async (baseUrl) => {
    const response = await postConfirmation(baseUrl, validConfirmationBody);
    assert.equal(response.status, 201);
    const payload = await response.json();
    assert.deepEqual(payload, { data: confirmationResult });
    const serialized = JSON.stringify(payload);
    assert.equal(serialized.includes(CLIENT_TOKEN), false);
    assert.equal(serialized.includes("slot_token"), false);
    assert.equal(serialized.includes("customer_id"), false);
  });
  assert.deepEqual(harness.calls, [
    {
      accessToken: CLIENT_TOKEN,
      idempotencyKey: IDEMPOTENCY_KEY,
      body: validConfirmationBody,
    },
  ]);
});

test("requires Bearer authentication and forwards the idempotency header", async () => {
  const harness = createConfirmationHarness();
  await withServer(harness.application, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/ai/appointments/confirm`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(validConfirmationBody),
    });
    assert.equal(response.status, 401);
  });
  assert.equal(harness.calls.length, 0);
});

test("maps missing idempotency keys and strict bodies to INVALID_REQUEST", async () => {
  const validatingConfirm: ConfirmAppointmentUseCase = async (
    _accessToken,
    idempotencyKey,
    body,
  ) => {
    const { AppointmentConfirmationRequestSchema, BookingIdempotencyKeySchema } =
      await import("../domain/ai-booking/index.js");
    BookingIdempotencyKeySchema.parse(idempotencyKey);
    AppointmentConfirmationRequestSchema.parse(body);
    return confirmationResult;
  };
  const harness = createConfirmationHarness(validatingConfirm);
  await withServer(harness.application, async (baseUrl) => {
    const missingKey = await postConfirmation(
      baseUrl,
      validConfirmationBody,
      null,
    );
    assert.equal(missingKey.status, 400);
    assert.equal((await missingKey.json()).error.code, "INVALID_REQUEST");

    const extraField = await postConfirmation(baseUrl, {
      ...validConfirmationBody,
      customer_id: 55,
    });
    assert.equal(extraField.status, 400);
    assert.equal((await extraField.json()).error.code, "INVALID_REQUEST");
  });
});

test("maps controlled confirmation errors without internal details", async () => {
  const cases = [
    ["INVALID_SLOT_TOKEN", 400],
    ["SLOT_OFFER_EXPIRED", 409],
    ["SLOT_NO_LONGER_AVAILABLE", 409],
    ["IDEMPOTENCY_CONFLICT", 409],
    ["BOOKING_CONTEXT_INVALID", 422],
    ["APPOINTMENT_CREATION_FAILED", 502],
    ["BOOKING_CONFIGURATION_UNAVAILABLE", 503],
  ] as const;

  for (const [code, status] of cases) {
    const harness = createConfirmationHarness(async () => {
      throw new BookingConfirmationError(code);
    });
    await withServer(harness.application, async (baseUrl) => {
      const response = await postConfirmation(baseUrl, validConfirmationBody);
      assert.equal(response.status, status);
      const payload = await response.json();
      assert.equal(payload.error.code, code);
      assert.equal(JSON.stringify(payload).includes(CLIENT_TOKEN), false);
      assert.equal(JSON.stringify(payload).includes("slot_token"), false);
    });
  }
});

test("maps an unexpected confirmation failure to a generic 500", async () => {
  const harness = createConfirmationHarness(async () => {
    throw new Error("private failure details");
  });
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    await withServer(harness.application, async (baseUrl) => {
      const response = await postConfirmation(baseUrl, validConfirmationBody);
      assert.equal(response.status, 500);
      assert.deepEqual(await response.json(), {
        error: {
          code: "INTERNAL_SERVER_ERROR",
          message: "An unexpected server error occurred.",
        },
      });
    });
  } finally {
    console.error = originalConsoleError;
  }
});
