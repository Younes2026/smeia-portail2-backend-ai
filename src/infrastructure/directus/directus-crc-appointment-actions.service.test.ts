import assert from "node:assert/strict";
import test from "node:test";

import { DirectusError } from "./directus-errors.js";
import {
  CrcDirectusActionStepError,
  createDirectusCrcAppointmentActionsService,
} from "./directus-crc-appointment-actions.service.js";
import type { DirectusFetch } from "./directus-http-client.js";

const WRITE_TOKEN = "unit-test-crc-write-token-placeholder";
const EVENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const IDEMPOTENCY_KEY = "123e4567-e89b-42d3-a456-426614174000";
const FINGERPRINT = "a".repeat(64);

const event = {
  id: EVENT_ID,
  appointment_id: 42,
  event_type: "callback_requested",
  actor_user_id: ACTOR_ID,
  date_created: "2026-08-23T10:00:00.000Z",
  status_from: "pending",
  status_to: "callback_pending",
  reason_code: null,
  callback_due_at: null,
  public_message: null,
  internal_note: "Nouvel appel sans réponse.",
  idempotency_key: IDEMPOTENCY_KEY,
  request_fingerprint: FINGERPRINT,
};

const jsonResponse = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });

test("reads idempotency, patches one appointment by ID and creates history", async () => {
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const fetchImplementation: DirectusFetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push({ url, init });
    if (init.method === "GET" && url.pathname.endsWith("/appointments/42")) {
      return jsonResponse({ data: { id: 42, status: "pending" } });
    }
    if (init.method === "GET") {
      return jsonResponse({ data: [] });
    }
    if (init.method === "PATCH") {
      return jsonResponse({ data: { id: 42, status: "callback_pending" } });
    }
    return jsonResponse({ data: event });
  };
  const service = createDirectusCrcAppointmentActionsService({
    baseUrl: "https://directus.example.test/directus",
    timeoutMs: 1_000,
    fetchImplementation,
  });

  assert.equal(
    await service.findEventByIdempotencyKey(
      WRITE_TOKEN,
      IDEMPOTENCY_KEY,
    ),
    null,
  );
  assert.equal(
    await service.getAppointmentStatus(WRITE_TOKEN, 42),
    "pending",
  );
  assert.equal(
    await service.updateAppointmentStatus(
      WRITE_TOKEN,
      42,
      "pending",
      "callback_pending",
    ),
    true,
  );
  assert.deepEqual(
    await service.createEvent(WRITE_TOKEN, {
      appointment_id: 42,
      event_type: "callback_requested",
      actor_user_id: ACTOR_ID,
      status_from: "pending",
      status_to: "callback_pending",
      internal_note: "Nouvel appel sans réponse.",
      idempotency_key: IDEMPOTENCY_KEY,
      request_fingerprint: FINGERPRINT,
    }),
    { eventId: EVENT_ID },
  );

  assert.equal(calls.length, 4);
  assert.equal(calls[0]?.url.pathname, "/directus/items/appointment_crc_events");
  assert.equal(
    calls[0]?.url.searchParams.get("fields"),
    "id,idempotency_key,request_fingerprint,event_type,appointment_id,status_to",
  );
  assert.equal(
    calls[0]?.url.searchParams.get("filter[idempotency_key][_eq]"),
    IDEMPOTENCY_KEY,
  );
  assert.equal(calls[0]?.url.searchParams.has("sort"), false);
  assert.equal(calls[0]?.url.searchParams.has("meta"), false);
  assert.equal(calls[0]?.url.searchParams.has("deep"), false);
  assert.equal(calls[1]?.url.pathname, "/directus/items/appointments/42");
  assert.equal(calls[1]?.url.searchParams.get("fields"), "id,status");
  assert.equal(calls[2]?.url.pathname, "/directus/items/appointments/42");
  assert.equal(calls[2]?.url.searchParams.get("fields"), "id,status");
  assert.equal(calls[2]?.url.searchParams.has("filter[id][_eq]"), false);
  assert.equal(calls[2]?.url.searchParams.has("filter[status][_eq]"), false);
  assert.deepEqual(JSON.parse(String(calls[2]?.init.body)), {
    status: "callback_pending",
  });
  assert.equal(calls[3]?.init.method, "POST");
  assert.equal(calls[3]?.url.searchParams.get("fields"), "id");
  assert.equal(calls.some(({ url }) => url.toString().includes(WRITE_TOKEN)), false);
  assert.equal(
    calls.some(({ init }) => String(init.body).includes(WRITE_TOKEN)),
    false,
  );
  for (const call of calls) {
    assert.equal(
      new Headers(call.init.headers).get("Authorization"),
      `Bearer ${WRITE_TOKEN}`,
    );
  }
});

test("rejects a collection-shaped response from an item PATCH", async () => {
  const service = createDirectusCrcAppointmentActionsService({
    baseUrl: "http://localhost:8055",
    timeoutMs: 1_000,
    fetchImplementation: async () => jsonResponse({ data: [] }),
  });
  await assert.rejects(
    service.updateAppointmentStatus(
      WRITE_TOKEN,
      42,
      "pending",
      "rejected",
    ),
    (error: unknown) =>
      error instanceof DirectusError &&
      error.code === "DIRECTUS_INVALID_RESPONSE",
  );
});

test("maps duplicate history and rejects malformed Directus data", async () => {
  const conflicting = createDirectusCrcAppointmentActionsService({
    baseUrl: "http://localhost:8055",
    timeoutMs: 1_000,
    fetchImplementation: async () => jsonResponse({}, 409),
  });
  await assert.rejects(
    conflicting.createEvent(WRITE_TOKEN, {
      appointment_id: 42,
      event_type: "confirmed",
      actor_user_id: ACTOR_ID,
      status_from: "pending",
      status_to: "confirmed",
      idempotency_key: IDEMPOTENCY_KEY,
      request_fingerprint: FINGERPRINT,
    }),
    (error: unknown) =>
      error instanceof DirectusError && error.code === "DIRECTUS_CONFLICT",
  );

  const malformed = createDirectusCrcAppointmentActionsService({
    baseUrl: "http://localhost:8055",
    timeoutMs: 1_000,
    fetchImplementation: async () => jsonResponse({ data: [{ id: 42 }] }),
  });
  await assert.rejects(
    malformed.updateAppointmentStatus(
      WRITE_TOKEN,
      42,
      "pending",
      "confirmed",
    ),
    (error: unknown) =>
      error instanceof DirectusError &&
      error.code === "DIRECTUS_INVALID_RESPONSE",
  );
});

test("preserves clean Directus errors for CRC writer operations", async () => {
  const service = createDirectusCrcAppointmentActionsService({
    baseUrl: "http://localhost:8055",
    timeoutMs: 1_000,
    fetchImplementation: async () => jsonResponse({}, 403),
  });
  const operations = [
    () => service.findEventByIdempotencyKey(WRITE_TOKEN, IDEMPOTENCY_KEY),
    () => service.getAppointmentStatus(WRITE_TOKEN, 42),
    () =>
      service.updateAppointmentStatus(
        WRITE_TOKEN,
        42,
        "pending",
        "callback_pending",
      ),
    () =>
      service.createEvent(WRITE_TOKEN, {
        appointment_id: 42,
        event_type: "callback_requested",
        actor_user_id: ACTOR_ID,
        status_from: "pending",
        status_to: "callback_pending",
        idempotency_key: IDEMPOTENCY_KEY,
        request_fingerprint: FINGERPRINT,
      }),
  ];

  for (const operation of operations) {
    await assert.rejects(operation, (error: unknown) => {
      assert.ok(error instanceof CrcDirectusActionStepError);
      assert.equal(error.httpStatus, 403);
      assert.equal(error.code, "DIRECTUS_FORBIDDEN");
      assert.equal(JSON.stringify(error).includes(WRITE_TOKEN), false);
      return true;
    });
  }
});

test("accepts a rich event response and normalizes a numeric event ID", async () => {
  const calls: URL[] = [];
  const service = createDirectusCrcAppointmentActionsService({
    baseUrl: "http://localhost:8055/private/path",
    timeoutMs: 1_000,
    fetchImplementation: async (input) => {
      calls.push(new URL(input instanceof Request ? input.url : String(input)));
      return jsonResponse(
        {
          data: {
            id: 7,
            appointment_id: { id: 42 },
            event_type: "callback_requested",
            actor_user_id: ACTOR_ID,
            status_from: "pending",
            status_to: "callback_pending",
            idempotency_key: IDEMPOTENCY_KEY,
            request_fingerprint: FINGERPRINT,
            date_created: "2026-08-23T10:00:00.000Z",
          },
        },
        201,
      );
    },
  });

  assert.deepEqual(
    await service.createEvent(WRITE_TOKEN, {
      appointment_id: 42,
      event_type: "callback_requested",
      actor_user_id: ACTOR_ID,
      status_from: "pending",
      status_to: "callback_pending",
      idempotency_key: IDEMPOTENCY_KEY,
      request_fingerprint: FINGERPRINT,
    }),
    { eventId: "7" },
  );
  assert.equal(calls[0]?.searchParams.get("fields"), "id");
});

test("treats an empty successful event response as recorded history", async () => {
  const service = createDirectusCrcAppointmentActionsService({
    baseUrl: "http://localhost:8055",
    timeoutMs: 1_000,
    fetchImplementation: async () => new Response(null, { status: 204 }),
  });

  assert.deepEqual(
    await service.createEvent(WRITE_TOKEN, {
      appointment_id: 42,
      event_type: "rejected",
      actor_user_id: ACTOR_ID,
      status_from: "pending",
      status_to: "rejected",
      reason_code: "service_unavailable",
      idempotency_key: IDEMPOTENCY_KEY,
      request_fingerprint: FINGERPRINT,
    }),
    {},
  );
});

test("hydrates only an existing idempotency event for a stable replay", async () => {
  const calls: URL[] = [];
  const service = createDirectusCrcAppointmentActionsService({
    baseUrl: "http://localhost:8055",
    timeoutMs: 1_000,
    fetchImplementation: async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      calls.push(url);
      if (calls.length === 1) {
        return jsonResponse({
          data: [
            {
              id: 7,
              idempotency_key: IDEMPOTENCY_KEY,
              request_fingerprint: FINGERPRINT,
              event_type: "callback_requested",
              appointment_id: { id: 42 },
              status_to: "callback_pending",
            },
          ],
        });
      }
      return jsonResponse({
        data: {
          id: 7,
          idempotency_key: IDEMPOTENCY_KEY,
          request_fingerprint: FINGERPRINT,
          event_type: "callback_requested",
          appointment_id: { id: 42 },
          status_to: "callback_pending",
          status_from: "pending",
        },
      });
    },
  });

  assert.deepEqual(
    await service.findEventByIdempotencyKey(WRITE_TOKEN, IDEMPOTENCY_KEY),
    {
      id: "7",
      idempotency_key: IDEMPOTENCY_KEY,
      request_fingerprint: FINGERPRINT,
      event_type: "callback_requested",
      appointment_id: 42,
      status_to: "callback_pending",
      status_from: "pending",
    },
  );
  assert.equal(calls.length, 2);
  assert.equal(
    calls[0]?.searchParams.get("fields"),
    "id,idempotency_key,request_fingerprint,event_type,appointment_id,status_to",
  );
  assert.equal(
    calls[1]?.searchParams.get("fields"),
    "id,idempotency_key,request_fingerprint,event_type,appointment_id,status_to,status_from",
  );
});
