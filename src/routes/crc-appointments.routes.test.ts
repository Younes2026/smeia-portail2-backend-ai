import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import type { Express } from "express";

import { createApp } from "../app.js";
import {
  createGetCrcAppointmentUseCase,
  createListCrcAppointmentsUseCase,
} from "../application/crc-appointments/index.js";
import type { CrcAppointment } from "../domain/crc-appointments/index.js";

const CRC_ROLE_ID = "0234F31D-78EC-416E-BE7F-989132F2B065";
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

const createHarness = (roleId = CRC_ROLE_ID) => {
  const listCalls: Array<{ token: string; query: unknown }> = [];
  const getCalls: Array<{ token: string; id: number }> = [];
  let identityCalls = 0;
  let appointmentResult: CrcAppointment | null = appointment;

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
      return {
        id: USER_ID,
        role: { id: roleId, name: roleId === CRC_ROLE_ID ? "Agent CRC" : "Client" },
      };
    },
    listCrcAppointments,
    getCrcAppointment,
  });

  return {
    application,
    getCalls,
    listCalls,
    getIdentityCalls: () => identityCalls,
    setAppointmentResult(value: CrcAppointment | null) {
      appointmentResult = value;
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
