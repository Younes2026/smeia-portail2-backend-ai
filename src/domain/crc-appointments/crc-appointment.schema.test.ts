import assert from "node:assert/strict";
import test from "node:test";

import {
  CrcCallbackActionBodySchema,
  CrcConfirmActionBodySchema,
  CrcAppointmentActionResultSchema,
  CrcAppointmentIdParameterSchema,
  CrcIdempotencyKeySchema,
  CrcAppointmentListQuerySchema,
  CrcAppointmentSchema,
  CrcRejectActionBodySchema,
} from "./index.js";

test("applies a bounded pending queue query by default", () => {
  assert.deepEqual(CrcAppointmentListQuerySchema.parse({}), {
    queue: "new",
    limit: 50,
    offset: 0,
  });
});

test("parses strict organizational filters without an agent workshop", () => {
  assert.deepEqual(
    CrcAppointmentListQuerySchema.parse({
      queue: "callback",
      city: " Casablanca ",
      showroom_id: "8",
      workshop_id: "20",
      date_from: "2026-08-18",
      date_to: "2026-08-20",
      limit: "25",
      offset: "50",
    }),
    {
      queue: "callback",
      city: "Casablanca",
      showroom_id: 8,
      workshop_id: 20,
      date_from: "2026-08-18",
      date_to: "2026-08-20",
      limit: 25,
      offset: 50,
    },
  );
});

test("rejects unknown filters, invalid ranges and invalid identifiers", () => {
  assert.equal(
    CrcAppointmentListQuerySchema.safeParse({ customer_id: "1" }).success,
    false,
  );
  assert.equal(
    CrcAppointmentListQuerySchema.safeParse({
      date_from: "2026-08-20",
      date_to: "2026-08-18",
    }).success,
    false,
  );
  assert.equal(
    CrcAppointmentListQuerySchema.safeParse({ showroom_id: ["8"] }).success,
    false,
  );
  assert.equal(CrcAppointmentIdParameterSchema.safeParse("0").success, false);
  assert.equal(CrcAppointmentIdParameterSchema.parse("42"), 42);
});

test("accepts only the strict CRC appointment read model", () => {
  const appointment = {
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

  assert.deepEqual(CrcAppointmentSchema.parse(appointment), appointment);
  assert.equal(
    CrcAppointmentSchema.safeParse({ ...appointment, status: "completed" })
      .success,
    false,
  );
  assert.equal(
    CrcAppointmentSchema.safeParse({ ...appointment, sav_agent_id: 3 })
      .success,
    false,
  );
});

test("validates strict callback, reject and confirmation action bodies", () => {
  assert.deepEqual(CrcCallbackActionBodySchema.parse({}), {});
  assert.deepEqual(
    CrcCallbackActionBodySchema.parse({
      callback_due_at: "2026-08-24T10:30:00+01:00",
      internal_note: " Nouvel appel sans réponse ",
    }),
    {
      callback_due_at: "2026-08-24T10:30:00+01:00",
      internal_note: "Nouvel appel sans réponse",
    },
  );
  assert.deepEqual(CrcConfirmActionBodySchema.parse({}), {});
  assert.deepEqual(
    CrcConfirmActionBodySchema.parse({
      selection: { slot_token: " signed-slot-token " },
      agreement_channel: "telephone",
      internal_note: " CrÃ©neau acceptÃ© par tÃ©lÃ©phone. ",
    }),
    {
      selection: { slot_token: "signed-slot-token" },
      agreement_channel: "telephone",
      internal_note: "CrÃ©neau acceptÃ© par tÃ©lÃ©phone.",
    },
  );
  assert.equal(
    CrcConfirmActionBodySchema.safeParse({
      selection: { slot_token: "signed-slot-token" },
    }).success,
    false,
  );
  assert.equal(
    CrcConfirmActionBodySchema.safeParse({
      selection: {
        slot_token: "signed-slot-token",
        requested_date: "2026-08-25",
      },
      agreement_channel: "telephone",
    }).success,
    false,
  );
  assert.equal(
    CrcConfirmActionBodySchema.safeParse({
      agreement_channel: "telephone",
    }).success,
    false,
  );
  assert.equal(
    CrcRejectActionBodySchema.safeParse({ reason_code: "other" }).success,
    false,
  );
  assert.equal(
    CrcRejectActionBodySchema.safeParse({
      reason_code: "other",
      internal_note: "Le motif a été vérifié par le CRC.",
    }).success,
    true,
  );
  assert.equal(
    CrcCallbackActionBodySchema.safeParse({ unexpected: true }).success,
    false,
  );
});

test("requires a UUID idempotency key and accepts the arrived status", () => {
  assert.equal(
    CrcIdempotencyKeySchema.safeParse(
      "123e4567-e89b-42d3-a456-426614174000",
    ).success,
    true,
  );
  assert.equal(CrcIdempotencyKeySchema.safeParse("not-a-uuid").success, false);

  const appointment = {
    id: 42,
    received_at: null,
    customer: null,
    vehicle: {
      id: 14,
      brand_name: null,
      model: null,
      registration_number: null,
    },
    service_type: { id: 2, name: "Diagnostic" },
    workshop: {
      id: 20,
      name: "Atelier Oujda",
      workshop_type: "diagnostic",
      showroom: {
        id: 8,
        name: "Oujda",
        city: null,
        address: null,
      },
    },
    requested_date: "2026-08-20",
    requested_time: "09:30:00",
    status: "arrived",
    problem_summary: null,
  };
  assert.equal(CrcAppointmentSchema.safeParse(appointment).success, true);
});

test("accepts the minimal reliable CRC action result", () => {
  assert.deepEqual(
    CrcAppointmentActionResultSchema.parse({
      appointment_id: 42,
      action: "callback",
      status_from: "pending",
      status_to: "callback_pending",
      history_recorded: true,
    }),
    {
      appointment_id: 42,
      action: "callback",
      status_from: "pending",
      status_to: "callback_pending",
      history_recorded: true,
    },
  );
  assert.equal(
    CrcAppointmentActionResultSchema.safeParse({
      appointment_id: 42,
      action: "reject",
      status_from: "callback_pending",
      status_to: "rejected",
      event_id: "7",
      history_recorded: true,
    }).success,
    true,
  );
});

test("accepts a strict selected-slot confirmation result without a slot token", () => {
  const result = {
    appointment_id: 34,
    action: "confirm",
    status_from: "pending",
    status_to: "confirmed",
    previous_slot: {
      date: "2026-08-31",
      time: "13:00:00",
    },
    selected_slot: {
      date: "2026-08-25",
      time: "10:30:00",
      workshop_id: 4,
    },
    agreement_channel: "telephone",
    event_id: "6",
    history_recorded: true,
  };

  assert.deepEqual(CrcAppointmentActionResultSchema.parse(result), result);
  assert.equal(
    CrcAppointmentActionResultSchema.safeParse({
      ...result,
      slot_token: "must-not-be-exposed",
    }).success,
    false,
  );
  assert.equal(
    CrcAppointmentActionResultSchema.safeParse({
      ...result,
      selected_slot: {
        ...result.selected_slot,
        workshop_id: 0,
      },
    }).success,
    false,
  );
});
