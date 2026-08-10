import assert from "node:assert/strict";
import test from "node:test";

import type { DirectusBookingAvailabilitySnapshot } from "../../domain/ai-booking/index.js";
import type { DirectusAiCatalogs } from "../../infrastructure/directus/index.js";
import { BookingAvailabilityError } from "./booking-errors.js";
import { createSearchAppointmentAvailabilityUseCase } from "./search-appointment-availability.use-case.js";

const CLIENT_TOKEN = "unit-test-client-token-placeholder";
const TODAY = new Date("2026-08-10T12:00:00.000Z");

const catalogs: DirectusAiCatalogs = {
  available_services: [
    { id: 2, name: "Diagnostic", code: "MEC-DIAG B" },
    { id: 3, name: "Devis mécanique", code: "MEC-DIAG B" },
    { id: 4, name: "Devis carrosserie", code: "CAR" },
    { id: 5, name: "Devis peinture", code: "PEINT" },
    { id: 6, name: "Carrosserie", code: "CAR" },
    { id: 7, name: "Peinture", code: "PEINT" },
    { id: 8, name: "Mécanique", code: "MEC-DIAG B" },
  ],
  available_workshops: [
    { id: 1, name: "Atelier Rapide", workshop_type: "diagnostic" },
    { id: 2, name: "Atelier mécanique", workshop_type: "mecanique" },
    { id: 3, name: "Atelier carrosserie", workshop_type: "carrosserie" },
    { id: 4, name: "Atelier peinture", workshop_type: "peinture" },
  ],
};

const snapshot: DirectusBookingAvailabilitySnapshot = {
  workshops: [
    {
      id: 1,
      name: "Atelier Rapide",
      opening_time: "08:00:00",
      closing_time: "17:00:00",
      working_days: ["monday", "tuesday", "wednesday", "thursday", "friday"],
      slot_interval_minutes: 30,
      active: true,
      client_bookable: true,
      showroom: {
        id: 1,
        name: "Moulay Slimane",
        address: "Adresse test",
        city: "Casablanca",
        phone: "0000000000",
      },
    },
  ],
  schedules: [
    {
      workshop_id: 1,
      date: "2026-08-12",
      total_capacity_hours: 36,
      used_capacity_hours: 0,
      remaining_capacity_hours: 36,
    },
  ],
  resources: [{ workshop_id: 1, active: true, daily_hours: 9 }],
  appointments: [],
};

const createHarness = (
  bookingSnapshot: DirectusBookingAvailabilitySnapshot = snapshot,
) => {
  const catalogTokens: string[] = [];
  const snapshotQueries: unknown[] = [];
  const useCase = createSearchAppointmentAvailabilityUseCase({
    async getAiCatalogs(accessToken) {
      catalogTokens.push(accessToken);
      return catalogs;
    },
    async getBookingSnapshot(query) {
      snapshotQueries.push(query);
      return bookingSnapshot;
    },
    now: () => TODAY,
  });
  return { catalogTokens, snapshotQueries, useCase };
};

test("verifies catalogs with the client token and searches a bounded range", async () => {
  const harness = createHarness();
  const result = await harness.useCase(CLIENT_TOKEN, {
    service_type_id: 2,
    workshop_ids: [1],
    preferred_date: "2026-08-12",
    preferred_period: "morning",
  });

  assert.deepEqual(harness.catalogTokens, [CLIENT_TOKEN]);
  assert.deepEqual(harness.snapshotQueries, [
    {
      workshopIds: [1],
      startDate: "2026-08-12",
      endDate: "2026-09-10",
    },
  ]);
  assert.equal(result.options[0]?.requested_date, "2026-08-12");
});

test("rejects workshop/service incompatibility before reading occupancy", async () => {
  const harness = createHarness();

  await assert.rejects(
    harness.useCase(CLIENT_TOKEN, {
      service_type_id: 4,
      workshop_ids: [1],
    }),
    (error: unknown) => {
      assert.ok(error instanceof BookingAvailabilityError);
      assert.equal(error.code, "BOOKING_AVAILABILITY_NOT_FOUND");
      return true;
    },
  );
  assert.equal(harness.snapshotQueries.length, 0);
});

test("returns a controlled not-found error when no slot exists", async () => {
  const harness = createHarness({
    workshops: [],
    schedules: [],
    resources: [],
    appointments: [],
  });

  await assert.rejects(
    harness.useCase(CLIENT_TOKEN, {
      service_type_id: 2,
      workshop_ids: [1],
    }),
    (error: unknown) => {
      assert.ok(error instanceof BookingAvailabilityError);
      assert.equal(error.code, "BOOKING_AVAILABILITY_NOT_FOUND");
      assert.equal(error.message.includes(CLIENT_TOKEN), false);
      return true;
    },
  );
});
