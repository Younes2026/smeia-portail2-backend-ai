import assert from "node:assert/strict";
import test from "node:test";

import { DirectusError } from "./directus-errors.js";
import {
  CrcDirectusActionStepError,
  createDirectusCrcAppointmentActionsService,
  type DirectusCrcAppointmentActionContext,
} from "./directus-crc-appointment-actions.service.js";
import type { DirectusFetch } from "./directus-http-client.js";

const WRITE_TOKEN = "unit-test-crc-write-token-placeholder";
const EVENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const IDEMPOTENCY_KEY = "123e4567-e89b-42d3-a456-426614174000";
const FINGERPRINT = "a".repeat(64);

const appointment: DirectusCrcAppointmentActionContext = {
  id: 42,
  status: "pending",
  requestedDate: "2026-08-24",
  requestedTime: "09:30:00",
  vehicleId: 14,
  serviceTypeId: 2,
  workshopId: 20,
  showroomId: 8,
};

const directusAppointment = {
  id: appointment.id,
  status: appointment.status,
  requested_date: appointment.requestedDate,
  requested_time: appointment.requestedTime,
  vehicle_id: { id: appointment.vehicleId },
  service_type_id: appointment.serviceTypeId,
  workshop_id: {
    id: appointment.workshopId,
    showroom_id: { id: appointment.showroomId },
  },
};

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
  internal_note: "Nouvel appel sans reponse.",
  idempotency_key: IDEMPOTENCY_KEY,
  request_fingerprint: FINGERPRINT,
};

const jsonResponse = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });

test("reads status and conditionally patches without loading relations", async () => {
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
      return jsonResponse({
        data: [
          {
            id: 42,
            status: "callback_pending",
          },
        ],
      });
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
  assert.equal(await service.getAppointmentStatus(WRITE_TOKEN, 42), "pending");
  assert.equal(
    await service.updateAppointmentStatus(
      WRITE_TOKEN,
      { id: 42, status: "pending" },
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
      internal_note: "Nouvel appel sans reponse.",
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
  assert.equal(calls[2]?.url.pathname, "/directus/items/appointments");
  assert.equal(calls[2]?.url.searchParams.get("fields"), "id,status");
  assert.deepEqual(JSON.parse(String(calls[2]?.init.body)), {
    query: {
      filter: {
        id: { _eq: 42 },
        status: { _eq: "pending" },
      },
      limit: 1,
    },
    data: { status: "callback_pending" },
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

test("normalizes scalar and object relation identifiers in appointment context", async () => {
  const service = createDirectusCrcAppointmentActionsService({
    baseUrl: "http://localhost:8055",
    timeoutMs: 1_000,
    fetchImplementation: async () =>
      jsonResponse({
        data: {
          ...directusAppointment,
          id: "42",
          requested_time: "09:30",
          vehicle_id: "14",
          service_type_id: { id: "999" },
          workshop_id: { id: "20", showroom_id: { id: "8" } },
        },
      }),
  });

  assert.deepEqual(await service.getAppointment(WRITE_TOKEN, 42), {
    ...appointment,
    serviceTypeId: 999,
  });
});

test("returns null when the writer cannot find the appointment or its status", async () => {
  const service = createDirectusCrcAppointmentActionsService({
    baseUrl: "http://localhost:8055",
    timeoutMs: 1_000,
    fetchImplementation: async () => jsonResponse({}, 404),
  });

  assert.equal(await service.getAppointmentStatus(WRITE_TOKEN, 42), null);
  assert.equal(await service.getAppointment(WRITE_TOKEN, 42), null);
});

test("labels an invalid writer appointment read with safe response metadata", async () => {
  const service = createDirectusCrcAppointmentActionsService({
    baseUrl: "http://localhost:8055",
    timeoutMs: 1_000,
    fetchImplementation: async () =>
      jsonResponse({ data: { id: "42", status: "pending" } }),
  });

  await assert.rejects(
    service.getAppointment(WRITE_TOKEN, 42),
    (error: unknown) => {
      assert.ok(error instanceof CrcDirectusActionStepError);
      assert.equal(error.code, "DIRECTUS_INVALID_RESPONSE");
      assert.equal(error.step, "CRC_APPOINTMENT_READ");
      assert.deepEqual(error.diagnostic, {
        directus_http_status: 200,
        response_kind: "json",
        data_kind: "object",
        field_names: ["id", "status"],
      });
      assert.equal(JSON.stringify(error).includes(WRITE_TOKEN), false);
      return true;
    },
  );
});

test("conditionally moves the existing appointment to a selected slot", async () => {
  let patchCall: { url: URL; init: RequestInit } | undefined;
  const service = createDirectusCrcAppointmentActionsService({
    baseUrl: "http://localhost:8055",
    timeoutMs: 1_000,
    fetchImplementation: async (input, init = {}) => {
      patchCall = {
        url: new URL(input instanceof Request ? input.url : String(input)),
        init,
      };
      return jsonResponse({
        data: [
          {
            id: 42,
            status: "confirmed",
            requested_date: "2026-08-26",
            requested_time: "14:00:00",
            workshop_id: 20,
          },
        ],
      });
    },
  });

  assert.equal(
    await service.updateAppointmentStatus(
      WRITE_TOKEN,
      appointment,
      "confirmed",
      { requestedDate: "2026-08-26", requestedTime: "14:00:00" },
    ),
    true,
  );
  assert.equal(patchCall?.url.pathname, "/items/appointments");
  assert.equal(patchCall?.init.method, "PATCH");
  assert.equal(
    patchCall?.url.searchParams.get("fields"),
    "id,status,requested_date,requested_time,workshop_id",
  );
  const patchBody = JSON.parse(String(patchCall?.init.body)) as Record<
    string,
    unknown
  >;
  assert.deepEqual(patchBody, {
    query: {
      filter: {
        id: { _eq: 42 },
        status: { _eq: "pending" },
        requested_date: { _eq: "2026-08-24" },
        requested_time: { _eq: "09:30:00" },
        workshop_id: { _eq: 20 },
      },
      limit: 1,
    },
    data: {
      status: "confirmed",
      requested_date: "2026-08-26",
      requested_time: "14:00:00",
    },
  });
  assert.equal(JSON.stringify(patchBody).includes("slot_token"), false);
  assert.equal(JSON.stringify(patchBody).includes("showroom_id"), false);
});

test("accepts numeric or text IDs, relation shapes and times without seconds", async (t) => {
  const responseItems = [
    {
      id: 42,
      status: "confirmed",
      requested_date: "2026-08-26",
      requested_time: "14:00:00",
      workshop_id: 20,
    },
    {
      id: "42",
      status: "confirmed",
      requested_date: "2026-08-26",
      requested_time: "14:00",
      workshop_id: { id: "20" },
    },
  ];

  for (const [index, responseItem] of responseItems.entries()) {
    await t.test(`response shape ${index + 1}`, async () => {
      const service = createDirectusCrcAppointmentActionsService({
        baseUrl: "http://localhost:8055",
        timeoutMs: 1_000,
        fetchImplementation: async () =>
          jsonResponse({ data: [responseItem] }),
      });

      assert.equal(
        await service.updateAppointmentStatus(
          WRITE_TOKEN,
          appointment,
          "confirmed",
          { requestedDate: "2026-08-26", requestedTime: "14:00:00" },
        ),
        true,
      );
    });
  }
});

test("verifies a minimal successful PATCH with an immediate writer GET", async () => {
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const service = createDirectusCrcAppointmentActionsService({
    baseUrl: "http://localhost:8055",
    timeoutMs: 1_000,
    fetchImplementation: async (input, init = {}) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      calls.push({ url, init });
      if (init.method === "PATCH") {
        return new Response(null, { status: 204 });
      }
      return jsonResponse({
        data: {
          id: "42",
          status: "confirmed",
          requested_date: "2026-08-26",
          requested_time: "14:00",
          workshop_id: { id: "20" },
        },
      });
    },
  });

  assert.equal(
    await service.updateAppointmentStatus(
      WRITE_TOKEN,
      appointment,
      "confirmed",
      { requestedDate: "2026-08-26", requestedTime: "14:00:00" },
    ),
    true,
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.init.method, "PATCH");
  assert.equal(calls[1]?.init.method, "GET");
  assert.equal(calls[1]?.url.pathname, "/items/appointments/42");
  assert.equal(
    calls[1]?.url.searchParams.get("fields"),
    "id,status,requested_date,requested_time,workshop_id",
  );
});

test("does not verify a minimal PATCH when the writer GET is unchanged", async () => {
  const methods: string[] = [];
  const service = createDirectusCrcAppointmentActionsService({
    baseUrl: "http://localhost:8055",
    timeoutMs: 1_000,
    fetchImplementation: async (_input, init = {}) => {
      methods.push(init.method ?? "GET");
      if (init.method === "PATCH") {
        return jsonResponse({ data: { id: "42" } });
      }
      return jsonResponse({
        data: {
          id: 42,
          status: "pending",
          requested_date: "2026-08-24",
          requested_time: "09:30:00",
          workshop_id: 20,
        },
      });
    },
  });

  assert.equal(
    await service.updateAppointmentStatus(
      WRITE_TOKEN,
      appointment,
      "confirmed",
      { requestedDate: "2026-08-26", requestedTime: "14:00:00" },
    ),
    false,
  );
  assert.deepEqual(methods, ["PATCH", "GET"]);
  assert.equal(methods.includes("POST"), false);
});

test("labels an invalid fallback GET as a PATCH verification read", async () => {
  const methods: string[] = [];
  const service = createDirectusCrcAppointmentActionsService({
    baseUrl: "http://localhost:8055",
    timeoutMs: 1_000,
    fetchImplementation: async (_input, init = {}) => {
      methods.push(init.method ?? "GET");
      if (init.method === "PATCH") {
        return new Response(null, { status: 204 });
      }
      return new Response("not-json", { status: 200 });
    },
  });

  await assert.rejects(
    service.updateAppointmentStatus(
      WRITE_TOKEN,
      appointment,
      "confirmed",
      { requestedDate: "2026-08-26", requestedTime: "14:00:00" },
    ),
    (error: unknown) => {
      assert.ok(error instanceof CrcDirectusActionStepError);
      assert.equal(error.code, "DIRECTUS_INVALID_RESPONSE");
      assert.equal(error.step, "CRC_PATCH_VERIFY_READ");
      assert.deepEqual(error.diagnostic, {
        directus_http_status: 200,
        response_kind: "non_json",
        data_kind: "missing",
      });
      return true;
    },
  );
  assert.deepEqual(methods, ["PATCH", "GET"]);
});

test("treats an empty filtered update result as a conflict without fallback read", async () => {
  let calls = 0;
  const service = createDirectusCrcAppointmentActionsService({
    baseUrl: "http://localhost:8055",
    timeoutMs: 1_000,
    fetchImplementation: async () => {
      calls += 1;
      return jsonResponse({ data: [] });
    },
  });

  assert.equal(
    await service.updateAppointmentStatus(
      WRITE_TOKEN,
      appointment,
      "confirmed",
      { requestedDate: "2026-08-26", requestedTime: "14:00:00" },
    ),
    false,
  );
  assert.equal(calls, 1);
});

test("returns false when the conditional transition matches no appointment", async () => {
  const service = createDirectusCrcAppointmentActionsService({
    baseUrl: "http://localhost:8055",
    timeoutMs: 1_000,
    fetchImplementation: async () => jsonResponse({ data: [] }),
  });

  assert.equal(
    await service.updateAppointmentStatus(
      WRITE_TOKEN,
      { id: 42, status: "pending" },
      "rejected",
    ),
    false,
  );
});

test("rejects malformed or multi-item conditional transition responses", async () => {
  for (const responsePayload of [
    { data: [{ id: 42 }] },
    {
      data: [
        {
          id: 42,
          status: "confirmed",
        },
        {
          id: 43,
          status: "confirmed",
        },
      ],
    },
  ]) {
    const service = createDirectusCrcAppointmentActionsService({
      baseUrl: "http://localhost:8055",
      timeoutMs: 1_000,
      fetchImplementation: async () => jsonResponse(responsePayload),
    });
    await assert.rejects(
      service.updateAppointmentStatus(
        WRITE_TOKEN,
        { id: 42, status: "pending" },
        "confirmed",
      ),
      (error: unknown) =>
        error instanceof DirectusError &&
        error.code === "DIRECTUS_INVALID_RESPONSE",
    );
  }
});

test("maps duplicate history and rejects a mismatched successful transition", async () => {
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

  const mismatched = createDirectusCrcAppointmentActionsService({
    baseUrl: "http://localhost:8055",
    timeoutMs: 1_000,
    fetchImplementation: async () =>
      jsonResponse({
        data: [
          {
            id: 42,
            status: "confirmed",
            requested_date: "2026-08-27",
            requested_time: "09:30:00",
          },
        ],
      }),
  });
  await assert.rejects(
    mismatched.updateAppointmentStatus(
      WRITE_TOKEN,
      appointment,
      "confirmed",
      { requestedDate: "2026-08-26", requestedTime: "09:30:00" },
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
    () => service.getAppointment(WRITE_TOKEN, 42),
    () =>
      service.updateAppointmentStatus(
        WRITE_TOKEN,
        { id: 42, status: "pending" },
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
