import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import type { Express } from "express";

import { createApp } from "../app.js";
import {
  CrcAppointmentActionError,
  createGetCrcAppointmentUseCase,
  createListCrcAppointmentsUseCase,
  type ExecuteCrcAppointmentActionInput,
} from "../application/crc-appointments/index.js";
import type {
  CrcAppointment,
  CrcAppointmentActionResult,
} from "../domain/crc-appointments/index.js";
import {
  CrcDirectusActionStepError,
  DirectusError,
} from "../infrastructure/directus/index.js";

const CRC_ROLE_ID = "0234F31D-78EC-4166-BE7F-989132F2B065";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const ACCESS_TOKEN = "unit-test-crc-token-placeholder";

const appointment: CrcAppointment = {
  id: 42,
  received_at: "2026-08-18T08:30:00.000Z",
  customer: {
    id: 5,
    first_name: "Sara",
    last_name: "Amrani",
    email: "sara@example.test",
    phone: "0600000000",
  },
  vehicle: {
    id: 14,
    brand_name: "BMW",
    model: "X1",
    registration_number: "12345-A-6",
  },
  service_type: { id: 2, name: "Diagnostic" },
  workshop: {
    id: 20,
    name: "Atelier Oujda",
    workshop_type: "diagnostic",
    showroom: {
      id: 8,
      name: "Oujda",
      city: "Oujda",
      address: "Adresse test",
    },
  },
  requested_date: "2026-08-20",
  requested_time: "09:30:00",
  status: "pending",
  problem_summary: "Le voyant moteur reste allume.",
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
      server.close((error) =>
        error === undefined ? resolve() : reject(error),
      );
    });
  }
};

const createHarness = (
  roleId = CRC_ROLE_ID,
  options: { omitRole?: boolean; identityError?: DirectusError } = {},
) => {
  const listCalls: Array<{ token: string; query: unknown }> = [];
  const getCalls: Array<{ token: string; id: number }> = [];
  const actionCalls: ExecuteCrcAppointmentActionInput[] = [];
  let identityCalls = 0;
  let appointmentResult: CrcAppointment | null = appointment;
  let actionError: Error | null = null;

  const listCrcAppointments = createListCrcAppointmentsUseCase({
    async listAppointments(token, query) {
      listCalls.push({ token, query });
      return [appointment];
    },
  });
  const getCrcAppointment = createGetCrcAppointmentUseCase({
    async getAppointment(token, id) {
      getCalls.push({ token, id });
      return appointmentResult;
    },
  });
  const application = createApp({
    crcRoleId: CRC_ROLE_ID.toLowerCase(),
    async getDirectusCurrentUser(token) {
      identityCalls += 1;
      assert.equal(token, ACCESS_TOKEN);
      if (options.identityError !== undefined) {
        throw options.identityError;
      }
      if (options.omitRole === true) {
        return { id: USER_ID };
      }
      return {
        id: USER_ID,
        role: { id: roleId, name: roleId === CRC_ROLE_ID ? "Agent CRC" : "Client" },
      };
    },
    listCrcAppointments,
    getCrcAppointment,
    async executeCrcAppointmentAction(input) {
      actionCalls.push(input);
      if (actionError !== null) {
        throw actionError;
      }
      const statusByAction = {
        callback: "callback_pending",
        reject: "rejected",
        confirm: "confirmed",
      } as const;
      const action = input.action as keyof typeof statusByAction;
      return {
        appointment_id: 42,
        action,
        status_from: "pending",
        status_to: statusByAction[action],
        event_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        history_recorded: true,
      } satisfies CrcAppointmentActionResult;
    },
  });

  return {
    application,
    getCalls,
    actionCalls,
    listCalls,
    getIdentityCalls: () => identityCalls,
    setAppointmentResult(value: CrcAppointment | null) {
      appointmentResult = value;
    },
    setActionError(value: Error | null) {
      actionError = value;
    },
  };
};

const crcHeaders = { Authorization: `Bearer ${ACCESS_TOKEN}` };

test("lists CRC appointments for the normalized Agent CRC role", async () => {
  const harness = createHarness();
  await withServer(harness.application, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/crc/appointments?queue=callback&showroom_id=8`,
      { headers: crcHeaders },
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { data: [appointment] });
  });
  assert.equal(harness.getIdentityCalls(), 1);
  assert.deepEqual(harness.listCalls, [
    {
      token: ACCESS_TOKEN,
      query: {
        queue: "callback",
        showroom_id: 8,
        limit: 50,
        offset: 0,
      },
    },
  ]);
});

test("returns one CRC appointment without exposing the token", async () => {
  const harness = createHarness();
  await withServer(harness.application, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/crc/appointments/42`, {
      headers: crcHeaders,
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.deepEqual(payload, { data: appointment });
    assert.equal(JSON.stringify(payload).includes(ACCESS_TOKEN), false);
  });
  assert.deepEqual(harness.getCalls, [{ token: ACCESS_TOKEN, id: 42 }]);
});

test("requires authentication and the exact Agent CRC role", async () => {
  const authenticatedHarness = createHarness();
  await withServer(authenticatedHarness.application, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/crc/appointments`);
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error.code, "AUTHORIZATION_REQUIRED");
  });
  assert.equal(authenticatedHarness.getIdentityCalls(), 0);
  assert.equal(authenticatedHarness.listCalls.length, 0);

  const forbiddenHarness = createHarness(
    "22222222-2222-4222-8222-222222222222",
  );
  await withServer(forbiddenHarness.application, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/crc/appointments`, {
      headers: crcHeaders,
    });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), {
      error: {
        code: "CRC_ROLE_REQUIRED",
        message: "Agent CRC access is required.",
      },
    });
  });
  assert.equal(forbiddenHarness.listCalls.length, 0);
});

test("returns 403 when Directus omits the current user role", async () => {
  const harness = createHarness(CRC_ROLE_ID, { omitRole: true });

  await withServer(harness.application, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/crc/appointments`, {
      headers: crcHeaders,
    });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), {
      error: {
        code: "CRC_ROLE_REQUIRED",
        message: "Agent CRC access is required.",
      },
    });
  });

  assert.equal(harness.getIdentityCalls(), 1);
  assert.equal(harness.listCalls.length, 0);
});

test("maps invalid and missing CRC appointment details", async () => {
  const harness = createHarness();
  harness.setAppointmentResult(null);
  await withServer(harness.application, async (baseUrl) => {
    const missing = await fetch(`${baseUrl}/api/crc/appointments/42`, {
      headers: crcHeaders,
    });
    assert.equal(missing.status, 404);
    assert.equal(
      (await missing.json()).error.code,
      "CRC_APPOINTMENT_NOT_FOUND",
    );

    const invalid = await fetch(`${baseUrl}/api/crc/appointments/not-an-id`, {
      headers: crcHeaders,
    });
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error.code, "INVALID_REQUEST");

    const unexpectedQuery = await fetch(
      `${baseUrl}/api/crc/appointments/42?expand=all`,
      { headers: crcHeaders },
    );
    assert.equal(unexpectedQuery.status, 400);
    assert.equal(
      (await unexpectedQuery.json()).error.code,
      "INVALID_REQUEST",
    );
  });
});

test("authorizes and forwards the three CRC actions with JSON bodies", async () => {
  const harness = createHarness();
  const actions = [
    {
      action: "callback",
      body: { internal_note: "Client injoignable" },
      expectedStatus: "callback_pending",
    },
    {
      action: "reject",
      body: { reason_code: "service_unavailable" },
      expectedStatus: "rejected",
    },
    {
      action: "confirm",
      body: { internal_note: "Confirmation de démonstration" },
      expectedStatus: "confirmed",
    },
  ] as const;

  await withServer(harness.application, async (baseUrl) => {
    for (const item of actions) {
      const response = await fetch(
        `${baseUrl}/api/crc/appointments/42/${item.action}`,
        {
          method: "POST",
          headers: {
            ...crcHeaders,
            "Content-Type": "application/json",
            "Idempotency-Key": "123e4567-e89b-42d3-a456-426614174000",
          },
          body: JSON.stringify(item.body),
        },
      );
      assert.equal(response.status, 200);
      const payload = await response.json();
      assert.equal(payload.data.status_to, item.expectedStatus);
      assert.equal(payload.data.action, item.action);
      assert.equal(payload.data.history_recorded, true);
      assert.equal(JSON.stringify(payload).includes(ACCESS_TOKEN), false);
    }
  });

  assert.equal(harness.actionCalls.length, 3);
  assert.deepEqual(harness.actionCalls[0], {
    accessToken: ACCESS_TOKEN,
    actorUserId: USER_ID,
    appointmentId: "42",
    action: "callback",
    idempotencyKey: "123e4567-e89b-42d3-a456-426614174000",
    body: { internal_note: "Client injoignable" },
  });
});

test("forwards a selected-slot confirmation without exposing its token", async () => {
  const harness = createHarness();
  const slotToken = "signed-slot-token-that-must-remain-request-only";
  const body = {
    selection: { slot_token: slotToken },
    agreement_channel: "telephone",
    internal_note: "Nouveau crÃ©neau acceptÃ© par tÃ©lÃ©phone.",
  } as const;

  await withServer(harness.application, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/crc/appointments/42/confirm`,
      {
        method: "POST",
        headers: {
          ...crcHeaders,
          "Content-Type": "application/json",
          "Idempotency-Key": "123e4567-e89b-42d3-a456-426614174000",
        },
        body: JSON.stringify(body),
      },
    );

    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(JSON.stringify(payload).includes(slotToken), false);
  });

  assert.equal(harness.actionCalls.length, 1);
  assert.deepEqual(harness.actionCalls[0], {
    accessToken: ACCESS_TOKEN,
    actorUserId: USER_ID,
    appointmentId: "42",
    action: "confirm",
    idempotencyKey: "123e4567-e89b-42d3-a456-426614174000",
    body,
  });
});

test("blocks CRC writes before the action and maps write configuration errors", async () => {
  const unauthenticated = createHarness();
  await withServer(unauthenticated.application, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/crc/appointments/42/callback`,
      { method: "POST" },
    );
    assert.equal(response.status, 401);
  });
  assert.equal(unauthenticated.actionCalls.length, 0);

  const wrongRole = createHarness(
    "22222222-2222-4222-8222-222222222222",
  );
  await withServer(wrongRole.application, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/crc/appointments/42/reject`,
      {
        method: "POST",
        headers: {
          ...crcHeaders,
          "Content-Type": "application/json",
          "Idempotency-Key": "123e4567-e89b-42d3-a456-426614174000",
        },
        body: JSON.stringify({ reason_code: "service_unavailable" }),
      },
    );
    assert.equal(response.status, 403);
  });
  assert.equal(wrongRole.actionCalls.length, 0);

  const unavailable = createHarness();
  unavailable.setActionError(
    new CrcAppointmentActionError("CRC_WRITE_CONFIGURATION_UNAVAILABLE"),
  );
  await withServer(unavailable.application, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/crc/appointments/42/confirm`,
      {
        method: "POST",
        headers: {
          ...crcHeaders,
          "Content-Type": "application/json",
          "Idempotency-Key": "123e4567-e89b-42d3-a456-426614174000",
        },
        body: "{}",
      },
    );
    assert.equal(response.status, 503);
    assert.equal(
      (await response.json()).error.code,
      "CRC_WRITE_CONFIGURATION_UNAVAILABLE",
    );
  });
});

test("maps an unavailable selected CRC slot to a clean HTTP 409", async () => {
  const harness = createHarness();
  harness.setActionError(
    new CrcAppointmentActionError("CRC_SLOT_NO_LONGER_AVAILABLE"),
  );

  await withServer(harness.application, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/crc/appointments/42/confirm`,
      {
        method: "POST",
        headers: {
          ...crcHeaders,
          "Content-Type": "application/json",
          "Idempotency-Key": "123e4567-e89b-42d3-a456-426614174000",
        },
        body: JSON.stringify({
          selection: { slot_token: "signed-slot-token" },
          agreement_channel: "telephone",
        }),
      },
    );

    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      error: {
        code: "CRC_SLOT_NO_LONGER_AVAILABLE",
        message: "The selected CRC slot is no longer available.",
      },
    });
  });
});

test("rejects action query parameters and malformed JSON before mutation", async () => {
  const harness = createHarness();
  await withServer(harness.application, async (baseUrl) => {
    const headers = {
      ...crcHeaders,
      "Content-Type": "application/json",
      "Idempotency-Key": "123e4567-e89b-42d3-a456-426614174000",
    };
    const queryResponse = await fetch(
      `${baseUrl}/api/crc/appointments/42/callback?force=true`,
      { method: "POST", headers, body: "{}" },
    );
    assert.equal(queryResponse.status, 400);

    const invalidJsonResponse = await fetch(
      `${baseUrl}/api/crc/appointments/42/callback`,
      { method: "POST", headers, body: "{" },
    );
    assert.equal(invalidJsonResponse.status, 400);
    assert.equal(
      (await invalidJsonResponse.json()).error.code,
      "INVALID_JSON",
    );
  });
  assert.equal(harness.actionCalls.length, 0);
});

test("returns a clean public Directus error for CRC actions", async () => {
  const harness = createHarness();
  harness.setActionError(
    new CrcDirectusActionStepError(
      new DirectusError("DIRECTUS_FORBIDDEN", 403),
    ),
  );
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...values: unknown[]) => warnings.push(values);
  try {
    await withServer(harness.application, async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/crc/appointments/42/callback`,
        {
          method: "POST",
          headers: {
            ...crcHeaders,
            "Content-Type": "application/json",
            "Idempotency-Key": "123e4567-e89b-42d3-a456-426614174000",
          },
          body: "{}",
        },
      );
      assert.equal(response.status, 403);
      assert.deepEqual(await response.json(), {
        error: {
          code: "DIRECTUS_FORBIDDEN",
          message: "Directus could not complete the CRC action.",
        },
      });
    });
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.length, 0);
});

test("exposes only safe CRC step metadata outside production", async () => {
  const harness = createHarness();
  harness.setActionError(
    new CrcDirectusActionStepError(
      new DirectusError("DIRECTUS_INVALID_RESPONSE", 200, {
        directus_http_status: 200,
        response_kind: "json",
        data_kind: "object",
        field_names: ["id", "status"],
      }),
      "CRC_APPOINTMENT_READ",
    ),
  );
  const previousNodeEnv = process.env.NODE_ENV;
  delete process.env.NODE_ENV;
  try {
    await withServer(harness.application, async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/crc/appointments/42/confirm`,
        {
          method: "POST",
          headers: {
            ...crcHeaders,
            "Content-Type": "application/json",
            "Idempotency-Key": "123e4567-e89b-42d3-a456-426614174000",
          },
          body: "{}",
        },
      );
      assert.equal(response.status, 502);
      assert.deepEqual(await response.json(), {
        error: {
          code: "DIRECTUS_INVALID_RESPONSE",
          message: "Directus could not complete the CRC action.",
        },
        diagnostic: {
          step: "CRC_APPOINTMENT_READ",
          directus_http_status: 200,
          response_kind: "json",
          data_kind: "object",
          field_names: ["id", "status"],
        },
      });
    });
  } finally {
    if (previousNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = previousNodeEnv;
    }
  }
});

test("never exposes CRC step diagnostics in production", async () => {
  const harness = createHarness();
  harness.setActionError(
    new CrcDirectusActionStepError(
      new DirectusError("DIRECTUS_INVALID_RESPONSE", 200, {
        directus_http_status: 200,
        response_kind: "json",
        data_kind: "array",
        data_length: 0,
      }),
      "CRC_CONDITIONAL_PATCH",
    ),
  );
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    await withServer(harness.application, async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/crc/appointments/42/confirm`,
        {
          method: "POST",
          headers: {
            ...crcHeaders,
            "Content-Type": "application/json",
            "Idempotency-Key": "123e4567-e89b-42d3-a456-426614174000",
          },
          body: "{}",
        },
      );
      assert.deepEqual(await response.json(), {
        error: {
          code: "DIRECTUS_INVALID_RESPONSE",
          message: "Directus could not complete the CRC action.",
        },
      });
    });
  } finally {
    if (previousNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = previousNodeEnv;
    }
  }
});

test("labels a forbidden users/me identity lookup", async () => {
  const harness = createHarness(CRC_ROLE_ID, {
    identityError: new DirectusError("DIRECTUS_FORBIDDEN", 403),
  });
  await withServer(harness.application, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/crc/appointments`, {
      headers: crcHeaders,
    });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), {
      error: {
        code: "DIRECTUS_FORBIDDEN",
        message: "Directus could not complete the CRC action.",
      },
    });
  });
});
