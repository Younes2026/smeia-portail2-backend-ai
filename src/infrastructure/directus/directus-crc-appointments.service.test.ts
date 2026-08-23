import assert from "node:assert/strict";
import test from "node:test";

import { CrcAppointmentListQuerySchema } from "../../domain/crc-appointments/index.js";
import { DirectusError } from "./directus-errors.js";
import { createDirectusCrcAppointmentsService } from "./directus-crc-appointments.service.js";
import type { DirectusReadClient } from "./directus-http-client.js";

const ACCESS_TOKEN = "unit-test-crc-token-placeholder";

const directusAppointment = {
  id: 42,
  customer_id: {
    id: 5,
    first_name: "Sara",
    last_name: "Amrani",
    email: "sara@example.test",
    phone: "0600000000",
  },
  vehicle_id: {
    id: 14,
    brand_id: { id: 1, name: "BMW" },
    model: "X1",
    registration_number: "12345-A-6",
  },
  service_type_id: { id: 2, name: "Diagnostic" },
  workshop_id: {
    id: 20,
    name: "Atelier Oujda",
    workshop_type: "diagnostic",
    showroom_id: {
      id: 8,
      name: "Oujda",
      city: "Oujda",
      address: "Adresse test",
    },
  },
  requested_date: "2026-08-20",
  requested_time: "09:30",
  status: "pending",
  comment: "Le voyant moteur reste allume.",
};

test("lists every-site CRC appointments with bounded organizational filters", async () => {
  const calls: Array<{
    endpoint: string;
    params: URLSearchParams;
    token: string;
  }> = [];
  const client: DirectusReadClient = {
    async getJson(endpoint, params, token) {
      calls.push({
        endpoint,
        params: new URLSearchParams(params),
        token,
      });
      return { data: [directusAppointment] };
    },
  };
  const service = createDirectusCrcAppointmentsService(client);
  const result = await service.listAppointments(
    ACCESS_TOKEN,
    CrcAppointmentListQuerySchema.parse({
      city: "Oujda",
      showroom_id: "8",
      workshop_id: "20",
      date_from: "2026-08-18",
      date_to: "2026-08-21",
    }),
  );

  assert.equal(result.length, 1);
  assert.deepEqual(result[0]?.workshop.showroom, {
    id: 8,
    name: "Oujda",
    city: "Oujda",
    address: "Adresse test",
  });
  assert.equal(result[0]?.requested_time, "09:30:00");
  assert.equal(result[0]?.received_at, null);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.endpoint, "/items/appointments");
  assert.equal(calls[0]?.token, ACCESS_TOKEN);
  assert.equal(calls[0]?.params.get("filter[status][_in]"), "pending");
  assert.equal(calls[0]?.params.get("sort"), "id");
  assert.equal(
    calls[0]?.params.get("filter[workshop_id][showroom_id][city][_eq]"),
    "Oujda",
  );
  assert.equal(
    calls[0]?.params.get("filter[workshop_id][showroom_id][_eq]"),
    "8",
  );
  assert.equal(calls[0]?.params.get("filter[workshop_id][_eq]"), "20");
  assert.equal(
    calls[0]?.params.get("fields")?.includes("workshop_id.showroom_id.id"),
    true,
  );
  assert.equal(calls[0]?.params.get("fields")?.includes("date_created"), false);
});

test("does not add an authorization workshop filter when none is requested", async () => {
  let capturedParams: URLSearchParams | null = null;
  const service = createDirectusCrcAppointmentsService({
    async getJson(_endpoint, params) {
      capturedParams = new URLSearchParams(params);
      return { data: [directusAppointment] };
    },
  });

  await service.listAppointments(
    ACCESS_TOKEN,
    CrcAppointmentListQuerySchema.parse({ queue: "new" }),
  );
  assert.equal(
    (capturedParams as URLSearchParams | null)?.has(
      "filter[workshop_id][_eq]",
    ),
    false,
  );
});

test("maps processed queues without treating filters as permissions", async () => {
  let capturedParams: URLSearchParams | null = null;
  const processed = {
    ...directusAppointment,
    status: "confirmed",
  };
  const service = createDirectusCrcAppointmentsService({
    async getJson(_endpoint, params) {
      capturedParams = new URLSearchParams(params);
      return { data: [processed] };
    },
  });

  await service.listAppointments(
    ACCESS_TOKEN,
    CrcAppointmentListQuerySchema.parse({ queue: "processed" }),
  );
  assert.equal(
    (capturedParams as URLSearchParams | null)?.get("filter[status][_in]"),
    "confirmed,rejected,cancelled,arrived",
  );
  assert.equal(
    (capturedParams as URLSearchParams | null)?.get("sort"),
    "id",
  );
});

test("loads one appointment and maps Directus 404 to null", async () => {
  let notFound = false;
  const service = createDirectusCrcAppointmentsService({
    async getJson(endpoint) {
      if (notFound) {
        throw new DirectusError("DIRECTUS_NOT_FOUND");
      }
      assert.equal(endpoint, "/items/appointments/42");
      return { data: directusAppointment };
    },
  });

  assert.equal((await service.getAppointment(ACCESS_TOKEN, 42))?.id, 42);
  notFound = true;
  assert.equal(await service.getAppointment(ACCESS_TOKEN, 42), null);
});

test("rejects unexpected Directus appointment fields", async () => {
  const service = createDirectusCrcAppointmentsService({
    async getJson() {
      return {
        data: [{ ...directusAppointment, sav_agent_id: 7 }],
      };
    },
  });

  await assert.rejects(
    () =>
      service.listAppointments(
        ACCESS_TOKEN,
        CrcAppointmentListQuerySchema.parse({}),
      ),
    (error: unknown) => {
      assert.ok(error instanceof DirectusError);
      assert.equal(error.code, "DIRECTUS_INVALID_RESPONSE");
      return true;
    },
  );
});
