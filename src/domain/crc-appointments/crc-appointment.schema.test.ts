import assert from "node:assert/strict";
import test from "node:test";

import {
  CrcAppointmentIdParameterSchema,
  CrcAppointmentListQuerySchema,
  CrcAppointmentSchema,
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
