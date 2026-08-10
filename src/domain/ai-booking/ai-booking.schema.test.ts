import assert from "node:assert/strict";
import test from "node:test";

import { createAppointmentAvailabilityRequestSchema } from "./ai-booking.schema.js";

const schema = createAppointmentAvailabilityRequestSchema("2026-08-10");

test("accepts the strict availability request and applies defaults", () => {
  assert.deepEqual(
    schema.parse({ service_type_id: 2, workshop_ids: [1, 2] }),
    {
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
      service_type_id: 2,
      workshop_ids: [1],
      customer_id: 99,
    }).success,
    false,
  );
  assert.equal(
    schema.safeParse({ service_type_id: 9, workshop_ids: [1] }).success,
    false,
  );
  assert.equal(
    schema.safeParse({ service_type_id: 2, workshop_ids: [1, 1] }).success,
    false,
  );
});

test("rejects malformed, impossible and past preferred dates", () => {
  for (const preferred_date of ["2026-8-12", "2026-02-30", "2026-08-09"]) {
    assert.equal(
      schema.safeParse({
        service_type_id: 2,
        workshop_ids: [1],
        preferred_date,
      }).success,
      false,
    );
  }
});
