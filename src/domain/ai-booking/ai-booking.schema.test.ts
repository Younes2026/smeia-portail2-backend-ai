import assert from "node:assert/strict";
import test from "node:test";

import {
  AppointmentConfirmationRequestSchema,
  BookingIdempotencyKeySchema,
  createAppointmentAvailabilityRequestSchema,
} from "./ai-booking.schema.js";

const schema = createAppointmentAvailabilityRequestSchema(
  "2026-08-10",
  "2026-09-08",
);

test("accepts the strict availability request and applies defaults", () => {
  assert.deepEqual(
    schema.parse({ vehicle_id: 14, service_type_id: 2, workshop_ids: [1, 2] }),
    {
      vehicle_id: 14,
      service_type_id: 2,
      workshop_ids: [1, 2],
      preferred_date: null,
      preferred_period: "any",
      result_mode: "suggestions",
    },
  );
});

test("rejects an unsupported result mode and a client-supplied limit", () => {
  for (const extra of [
    { result_mode: "all" },
    { result_mode: "day_slots", preferred_date: "2026-08-12", limit: 10 },
  ]) {
    assert.equal(
      schema.safeParse({
        vehicle_id: 14,
        service_type_id: 2,
        workshop_ids: [1],
        ...extra,
      }).success,
      false,
    );
  }
});

test("requires a non-null preferred date in day-slots mode", () => {
  for (const preferred_date of [undefined, null]) {
    assert.equal(
      schema.safeParse({
        vehicle_id: 14,
        service_type_id: 2,
        workshop_ids: [1],
        preferred_date,
        result_mode: "day_slots",
      }).success,
      false,
    );
  }
});

test("rejects a day-slots date outside the global booking window", () => {
  for (const preferred_date of ["2026-08-09", "2026-09-09"]) {
    assert.equal(
      schema.safeParse({
        vehicle_id: 14,
        service_type_id: 2,
        workshop_ids: [1],
        preferred_date,
        result_mode: "day_slots",
      }).success,
      false,
    );
  }
});

test("rejects additional properties, unsupported IDs and duplicate workshops", () => {
  assert.equal(
    schema.safeParse({
      vehicle_id: 14,
      service_type_id: 2,
      workshop_ids: [1],
      customer_id: 99,
    }).success,
    false,
  );
  assert.equal(
    schema.safeParse({
      vehicle_id: 14,
      service_type_id: 9,
      workshop_ids: [1],
    }).success,
    false,
  );
  assert.equal(
    schema.safeParse({
      vehicle_id: 14,
      service_type_id: 2,
      workshop_ids: [1, 1],
    }).success,
    false,
  );
});

test("requires a positive safe integer vehicle ID", () => {
  for (const vehicle_id of [
    undefined,
    "14",
    0,
    -1,
    14.5,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    assert.equal(
      schema.safeParse({
        vehicle_id,
        service_type_id: 2,
        workshop_ids: [1],
      }).success,
      false,
    );
  }
});

test("rejects malformed, impossible and past preferred dates", () => {
  for (const preferred_date of ["2026-8-12", "2026-02-30", "2026-08-09"]) {
    assert.equal(
      schema.safeParse({
        vehicle_id: 14,
        service_type_id: 2,
        workshop_ids: [1],
        preferred_date,
      }).success,
      false,
    );
  }
});

test("accepts the last booking-window date and rejects later dates", () => {
  assert.equal(
    schema.safeParse({
      vehicle_id: 14,
      service_type_id: 2,
      workshop_ids: [1],
      preferred_date: "2026-09-08",
    }).success,
    true,
  );
  assert.equal(
    schema.safeParse({
      vehicle_id: 14,
      service_type_id: 2,
      workshop_ids: [1],
      preferred_date: "2026-09-09",
    }).success,
    false,
  );
});

test("accepts and trims the strict appointment confirmation contract", () => {
  assert.deepEqual(
    AppointmentConfirmationRequestSchema.parse({
      slot_token: " signed-token ",
      problem_summary: "  Voyant moteur allumé avec vibrations.  ",
      confirmation: true,
    }),
    {
      slot_token: "signed-token",
      problem_summary: "Voyant moteur allumé avec vibrations.",
      confirmation: true,
    },
  );
  assert.equal(
    BookingIdempotencyKeySchema.parse(
      "123e4567-e89b-42d3-a456-426614174000",
    ),
    "123e4567-e89b-42d3-a456-426614174000",
  );
});

test("rejects unsafe confirmation bodies and invalid idempotency keys", () => {
  const valid = {
    slot_token: "signed-token",
    problem_summary: "Voyant moteur allumé avec vibrations.",
    confirmation: true,
  } as const;
  for (const invalid of [
    { ...valid, confirmation: false },
    { ...valid, customer_id: 99 },
    { ...valid, status: "pending" },
    { ...valid, requested_date: "2026-08-12" },
    { ...valid, problem_summary: "<b>Diagnostic</b>" },
    { ...valid, slot_token: "x".repeat(4_097) },
  ]) {
    assert.equal(
      AppointmentConfirmationRequestSchema.safeParse(invalid).success,
      false,
    );
  }
  assert.equal(BookingIdempotencyKeySchema.safeParse("not-a-uuid").success, false);
});
