import assert from "node:assert/strict";
import test from "node:test";

import {
  AppointmentAvailabilityCalendarResultSchema,
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
    schema.parse({
      vehicle_id: 14,
      service_type_id: 2,
      showroom_id: 8,
      workshop_types: ["diagnostic", "mecanique"],
    }),
    {
      vehicle_id: 14,
      service_type_id: 2,
      showroom_id: 8,
      workshop_types: ["diagnostic", "mecanique"],
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
        showroom_id: 8,
        workshop_types: ["mecanique"],
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
        showroom_id: 8,
        workshop_types: ["mecanique"],
        preferred_date,
        result_mode: "day_slots",
      }).success,
      false,
    );
  }
});

test("accepts calendar mode only for the complete horizon and all periods", () => {
  assert.deepEqual(
    schema.parse({
      vehicle_id: 14,
      service_type_id: 2,
      showroom_id: 8,
      workshop_types: ["mecanique"],
      result_mode: "calendar",
    }),
    {
      vehicle_id: 14,
      service_type_id: 2,
      showroom_id: 8,
      workshop_types: ["mecanique"],
      preferred_date: null,
      preferred_period: "any",
      result_mode: "calendar",
    },
  );

  for (const overrides of [
    { preferred_date: "2026-08-12" },
    { preferred_period: "morning" },
  ]) {
    assert.equal(
      schema.safeParse({
        vehicle_id: 14,
        service_type_id: 2,
        showroom_id: 8,
        workshop_types: ["mecanique"],
        result_mode: "calendar",
        ...overrides,
      }).success,
      false,
    );
  }
});

test("strictly validates the minimal calendar response", () => {
  const validCalendar = {
    result_mode: "calendar",
    timezone: "Africa/Casablanca",
    horizon_start: "2026-08-10",
    horizon_end: "2026-09-08",
    days: [
      {
        date: "2026-08-11",
        available_slot_count: 18,
        morning_slot_count: 8,
        afternoon_slot_count: 10,
      },
    ],
  } as const;

  assert.deepEqual(
    AppointmentAvailabilityCalendarResultSchema.parse(validCalendar),
    validCalendar,
  );
  for (const invalid of [
    { ...validCalendar, slot_token: "forbidden" },
    {
      ...validCalendar,
      days: [
        {
          ...validCalendar.days[0],
          available_slot_count: 19,
        },
      ],
    },
    {
      ...validCalendar,
      days: [
        { ...validCalendar.days[0], unexpected: true },
      ],
    },
  ]) {
    assert.equal(
      AppointmentAvailabilityCalendarResultSchema.safeParse(invalid).success,
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
        showroom_id: 8,
        workshop_types: ["mecanique"],
        preferred_date,
        result_mode: "day_slots",
      }).success,
      false,
    );
  }
});

test("rejects old physical IDs, unsupported values and duplicate workshop types", () => {
  assert.equal(
    schema.safeParse({
      vehicle_id: 14,
      service_type_id: 2,
      showroom_id: 8,
      workshop_types: ["mecanique"],
      customer_id: 99,
    }).success,
    false,
  );
  assert.equal(
    schema.safeParse({
      vehicle_id: 14,
      service_type_id: 9,
      showroom_id: 8,
      workshop_types: ["mecanique"],
    }).success,
    false,
  );
  assert.equal(
    schema.safeParse({
      vehicle_id: 14,
      service_type_id: 2,
      showroom_id: 8,
      workshop_types: ["mecanique", "mecanique"],
    }).success,
    false,
  );
  assert.equal(
    schema.safeParse({
      vehicle_id: 14,
      service_type_id: 2,
      showroom_id: 8,
      workshop_types: ["mecanique"],
      workshop_ids: [20],
    }).success,
    false,
  );
  for (const workshop_types of [[], ["electricite"], ["diagnostic", "mecanique", "peinture"]]) {
    assert.equal(
      schema.safeParse({
        vehicle_id: 14,
        service_type_id: 2,
        showroom_id: 8,
        workshop_types,
      }).success,
      false,
    );
  }
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
        showroom_id: 8,
        workshop_types: ["mecanique"],
      }).success,
      false,
    );
  }
});

test("requires a positive safe integer showroom ID", () => {
  for (const showroom_id of [
    undefined,
    "8",
    0,
    -1,
    8.5,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    assert.equal(
      schema.safeParse({
        vehicle_id: 14,
        service_type_id: 2,
        showroom_id,
        workshop_types: ["mecanique"],
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
        showroom_id: 8,
        workshop_types: ["mecanique"],
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
      showroom_id: 8,
      workshop_types: ["mecanique"],
      preferred_date: "2026-09-08",
    }).success,
    true,
  );
  assert.equal(
    schema.safeParse({
      vehicle_id: 14,
      service_type_id: 2,
      showroom_id: 8,
      workshop_types: ["mecanique"],
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
