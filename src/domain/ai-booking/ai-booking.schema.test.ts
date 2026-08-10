import assert from "node:assert/strict";
import test from "node:test";

import { createAppointmentAvailabilityRequestSchema } from "./ai-booking.schema.js";

const schema = createAppointmentAvailabilityRequestSchema("2026-08-10");

test("accepts the strict availability request and applies defaults", () => {
  assert.deepEqual(
    schema.parse({ vehicle_id: 14, service_type_id: 2, workshop_ids: [1, 2] }),
    {
      vehicle_id: 14,
      service_type_id: 2,
      workshop_ids: [1, 2],
      preferred_date: null,
      preferred_period: "any",
    },
  );
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
