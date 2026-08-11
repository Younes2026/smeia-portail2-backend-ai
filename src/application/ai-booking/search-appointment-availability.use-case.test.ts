import assert from "node:assert/strict";
import test from "node:test";

import type { DirectusBookingAvailabilitySnapshot } from "../../domain/ai-booking/index.js";
import {
  DirectusError,
  type DirectusAiCatalogs,
  type DirectusVehicleContext,
} from "../../infrastructure/directus/index.js";
import { BookingAvailabilityError } from "./booking-errors.js";
import { createBookingSlotTokenService } from "./booking-slot-token.service.js";
import { createSearchAppointmentAvailabilityUseCase } from "./search-appointment-availability.use-case.js";

const CLIENT_TOKEN = "unit-test-client-token-placeholder";
const SLOT_SECRET = "unit-test-booking-slot-secret-placeholder";
const TODAY = new Date("2026-08-10T12:00:00.000Z");

const vehicleContext: DirectusVehicleContext = {
  vehicle_id: 14,
  brand: "BMW",
  model: "Unknown",
  year: null,
  mileage: 6_472,
};

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

type HarnessOptions = {
  bookingSnapshot?: DirectusBookingAvailabilitySnapshot;
  slotSecret?: string;
  getVehicleContext?: (
    accessToken: string,
    vehicleId: unknown,
  ) => Promise<DirectusVehicleContext>;
};

const createHarness = (options: HarnessOptions = {}) => {
  const vehicleCalls: Array<{ accessToken: string; vehicleId: unknown }> = [];
  const catalogTokens: string[] = [];
  const snapshotQueries: unknown[] = [];
  const useCase = createSearchAppointmentAvailabilityUseCase({
    async getVehicleContext(accessToken, vehicleId) {
      vehicleCalls.push({ accessToken, vehicleId });
      if (options.getVehicleContext !== undefined) {
        return options.getVehicleContext(accessToken, vehicleId);
      }
      return vehicleContext;
    },
    async getAiCatalogs(accessToken) {
      catalogTokens.push(accessToken);
      return catalogs;
    },
    async getBookingSnapshot(query) {
      snapshotQueries.push(query);
      return options.bookingSnapshot ?? snapshot;
    },
    slotTokenService: createBookingSlotTokenService({
      secret: options.slotSecret ?? SLOT_SECRET,
      now: () => TODAY,
    }),
    now: () => TODAY,
  });
  return { catalogTokens, snapshotQueries, useCase, vehicleCalls };
};

const validRequest = {
  vehicle_id: 14,
  service_type_id: 2,
  workshop_ids: [1],
  preferred_date: "2026-08-12",
  preferred_period: "morning",
} as const;

test("uses the client token and stops the search at the global window end", async () => {
  const harness = createHarness();
  await harness.useCase(CLIENT_TOKEN, validRequest);

  assert.deepEqual(harness.vehicleCalls, [
    { accessToken: CLIENT_TOKEN, vehicleId: 14 },
  ]);
  assert.deepEqual(harness.catalogTokens, [CLIENT_TOKEN]);
  assert.deepEqual(harness.snapshotQueries, [
    {
      workshopIds: [1],
      startDate: "2026-08-12",
      endDate: "2026-09-08",
    },
  ]);
});

test("returns the service name and one signed token for each of at most three options", async () => {
  const harness = createHarness();
  const result = await harness.useCase(CLIENT_TOKEN, validRequest);
  const verifier = createBookingSlotTokenService({
    secret: SLOT_SECRET,
    now: () => TODAY,
  });

  assert.equal(result.options.length, 3);
  assert.ok(result.options.every((option) => option.slot_token.length > 0));
  assert.ok(
    result.options.every(
      (option) => option.expires_at === "2026-08-10T12:10:00.000Z",
    ),
  );
  assert.deepEqual(result.options[0]?.service_type, {
    id: 2,
    name: "Diagnostic",
  });
  assert.deepEqual(
    verifier.verify(result.options[0]?.slot_token ?? ""),
    {
      version: 1,
      expiration: 1_786_363_800,
      vehicle_id: 14,
      service_type_id: 2,
      workshop_id: 1,
      requested_date: "2026-08-12",
      requested_time: "08:00:00",
      slot_interval_minutes: 30,
    },
  );
});

test("day-slots reads one date and signs every returned option", async () => {
  const harness = createHarness();
  const result = await harness.useCase(CLIENT_TOKEN, {
    ...validRequest,
    preferred_period: "any",
    result_mode: "day_slots",
  });
  const verifier = createBookingSlotTokenService({
    secret: SLOT_SECRET,
    now: () => TODAY,
  });

  assert.deepEqual(harness.snapshotQueries, [
    {
      workshopIds: [1],
      startDate: "2026-08-12",
      endDate: "2026-08-12",
    },
  ]);
  assert.equal(result.preferred_date_available, true);
  assert.equal(result.options.length, 18);
  assert.ok(
    result.options.every(
      (option) =>
        option.requested_date === "2026-08-12" &&
        option.slot_token.length > 0 &&
        verifier.verify(option.slot_token).requested_time ===
          option.requested_time,
    ),
  );
});

test("rejects an inaccessible vehicle before catalog or occupancy reads", async () => {
  const harness = createHarness({
    async getVehicleContext() {
      throw new DirectusError("DIRECTUS_VEHICLE_NOT_ACCESSIBLE");
    },
  });

  await assert.rejects(
    harness.useCase(CLIENT_TOKEN, validRequest),
    (error: unknown) => {
      assert.ok(error instanceof DirectusError);
      assert.equal(error.code, "DIRECTUS_VEHICLE_NOT_ACCESSIBLE");
      return true;
    },
  );
  assert.equal(harness.catalogTokens.length, 0);
  assert.equal(harness.snapshotQueries.length, 0);
});

test("rejects workshop/service incompatibility before reading occupancy", async () => {
  const harness = createHarness();

  await assert.rejects(
    harness.useCase(CLIENT_TOKEN, {
      ...validRequest,
      service_type_id: 4,
    }),
    (error: unknown) => {
      assert.ok(error instanceof BookingAvailabilityError);
      assert.equal(error.code, "BOOKING_AVAILABILITY_NOT_FOUND");
      return true;
    },
  );
  assert.equal(harness.snapshotQueries.length, 0);
});

test("returns a controlled not-found error when no day slot exists", async () => {
  const harness = createHarness({
    bookingSnapshot: {
      workshops: [],
      schedules: [],
      resources: [],
      appointments: [],
    },
  });

  await assert.rejects(
    harness.useCase(CLIENT_TOKEN, {
      ...validRequest,
      result_mode: "day_slots",
    }),
    (error: unknown) => {
      assert.ok(error instanceof BookingAvailabilityError);
      assert.equal(error.code, "BOOKING_AVAILABILITY_NOT_FOUND");
      assert.equal(error.message.includes(CLIENT_TOKEN), false);
      return true;
    },
  );
});

test("returns a controlled not-found error when the requested period has no slot", async () => {
  const workshop = snapshot.workshops[0];
  assert.ok(workshop);
  const harness = createHarness({
    bookingSnapshot: {
      ...snapshot,
      workshops: [
        {
          ...workshop,
          opening_time: "13:00:00",
          closing_time: "17:00:00",
        },
      ],
    },
  });

  await assert.rejects(
    harness.useCase(CLIENT_TOKEN, validRequest),
    (error: unknown) => {
      assert.ok(error instanceof BookingAvailabilityError);
      assert.equal(error.code, "BOOKING_AVAILABILITY_NOT_FOUND");
      return true;
    },
  );
});

test("returns a controlled configuration error before any Directus read", async () => {
  const harness = createHarness({ slotSecret: " " });

  await assert.rejects(
    harness.useCase(CLIENT_TOKEN, validRequest),
    (error: unknown) => {
      assert.ok(error instanceof BookingAvailabilityError);
      assert.equal(error.code, "BOOKING_CONFIGURATION_ERROR");
      return true;
    },
  );
  assert.equal(harness.vehicleCalls.length, 0);
  assert.equal(harness.catalogTokens.length, 0);
  assert.equal(harness.snapshotQueries.length, 0);
});
