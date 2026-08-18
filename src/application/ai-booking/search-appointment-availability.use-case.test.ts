import assert from "node:assert/strict";
import test from "node:test";

import type { DirectusBookingAvailabilitySnapshot } from "../../domain/ai-booking/index.js";
import {
  DirectusError,
  type AvailableService,
  type DirectusAiCatalogs,
  type DirectusVehicleContext,
  type ResolvedBookingWorkshop,
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

const resolvedWorkshop: ResolvedBookingWorkshop = {
  id: 20,
  name: "Atelier Oujda",
  workshop_type: "mecanique",
  opening_time: "08:00:00",
  closing_time: "17:00:00",
  working_days: ["monday", "tuesday", "wednesday", "thursday", "friday"],
  slot_interval_minutes: 30,
  active: true,
  client_bookable: true,
  showroom: {
    id: 8,
    name: "Oujda",
    address: "Adresse test",
    city: "Oujda",
    phone: "0000000000",
  },
};

const snapshot: DirectusBookingAvailabilitySnapshot = {
  workshops: [
    {
      id: 20,
      name: "Atelier Oujda",
      workshop_type: "mecanique",
      opening_time: "08:00:00",
      closing_time: "17:00:00",
      working_days: ["monday", "tuesday", "wednesday", "thursday", "friday"],
      slot_interval_minutes: 30,
      active: true,
      client_bookable: true,
      showroom: {
        id: 8,
        name: "Oujda",
        address: "Adresse test",
        city: "Casablanca",
        phone: "0000000000",
      },
    },
  ],
  schedules: [
    {
      workshop_id: 20,
      date: "2026-08-12",
      total_capacity_hours: 36,
      used_capacity_hours: 0,
      remaining_capacity_hours: 36,
    },
  ],
  resources: [{ workshop_id: 20, active: true, daily_hours: 9 }],
  appointments: [],
};

type HarnessOptions = {
  bookingSnapshot?: DirectusBookingAvailabilitySnapshot;
  slotSecret?: string;
  getVehicleContext?: (
    accessToken: string,
    vehicleId: unknown,
  ) => Promise<DirectusVehicleContext>;
  getAvailableService?: (
    accessToken: string,
    serviceId: unknown,
  ) => Promise<AvailableService>;
  resolveWorkshops?: () => Promise<ResolvedBookingWorkshop[]>;
};

const createHarness = (options: HarnessOptions = {}) => {
  const vehicleCalls: Array<{ accessToken: string; vehicleId: unknown }> = [];
  const serviceCalls: Array<{ accessToken: string; serviceId: unknown }> = [];
  const resolverQueries: unknown[] = [];
  const snapshotQueries: unknown[] = [];
  const useCase = createSearchAppointmentAvailabilityUseCase({
    async getVehicleContext(accessToken, vehicleId) {
      vehicleCalls.push({ accessToken, vehicleId });
      if (options.getVehicleContext !== undefined) {
        return options.getVehicleContext(accessToken, vehicleId);
      }
      return vehicleContext;
    },
    async getAvailableService(accessToken, serviceId) {
      serviceCalls.push({ accessToken, serviceId });
      if (options.getAvailableService !== undefined) {
        return options.getAvailableService(accessToken, serviceId);
      }
      const service = catalogs.available_services.find(
        (candidate) => candidate.id === serviceId,
      );
      if (service === undefined) {
        throw new DirectusError("DIRECTUS_NOT_FOUND");
      }
      return service;
    },
    async resolveBookingWorkshops(query) {
      resolverQueries.push(query);
      return options.resolveWorkshops?.() ?? [resolvedWorkshop];
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
  return {
    resolverQueries,
    serviceCalls,
    snapshotQueries,
    useCase,
    vehicleCalls,
  };
};

const validRequest = {
  vehicle_id: 14,
  service_type_id: 2,
  showroom_id: 8,
  workshop_types: ["mecanique"],
  preferred_date: "2026-08-12",
  preferred_period: "morning",
} as const;

test("uses the client token and stops the search at the global window end", async () => {
  const harness = createHarness();
  await harness.useCase(CLIENT_TOKEN, validRequest);

  assert.deepEqual(harness.vehicleCalls, [
    { accessToken: CLIENT_TOKEN, vehicleId: 14 },
  ]);
  assert.deepEqual(harness.serviceCalls, [
    { accessToken: CLIENT_TOKEN, serviceId: 2 },
  ]);
  assert.deepEqual(harness.resolverQueries, [
    { showroomId: 8, workshopTypes: ["mecanique"] },
  ]);
  assert.deepEqual(harness.snapshotQueries, [
    {
      workshopIds: [20],
      showroomId: 8,
      startDate: "2026-08-12",
      endDate: "2026-09-08",
    },
  ]);
});

test("resolves Tanger carrosserie to physical workshop 24", async () => {
  const tangerWorkshop: ResolvedBookingWorkshop = {
    ...resolvedWorkshop,
    id: 24,
    name: "Atelier Tanger",
    workshop_type: "carrosserie",
    showroom: {
      ...resolvedWorkshop.showroom,
      id: 5,
      name: "Tanger",
      city: "Tanger",
    },
  };
  const tangerSnapshot: DirectusBookingAvailabilitySnapshot = {
    workshops: [tangerWorkshop],
    schedules: [{ ...snapshot.schedules[0]!, workshop_id: 24 }],
    resources: [{ workshop_id: 24, active: true, daily_hours: 9 }],
    appointments: [],
  };
  const harness = createHarness({
    bookingSnapshot: tangerSnapshot,
    resolveWorkshops: async () => [tangerWorkshop],
  });

  const result = await harness.useCase(CLIENT_TOKEN, {
    ...validRequest,
    service_type_id: 4,
    showroom_id: 5,
    workshop_types: ["carrosserie"],
  });

  assert.ok("options" in result);
  assert.equal(result.options[0]?.workshop_id, 24);
  assert.equal(result.options[0]?.showroom.id, 5);
  assert.deepEqual(harness.snapshotQueries[0], {
    workshopIds: [24],
    showroomId: 5,
    startDate: "2026-08-12",
    endDate: "2026-09-08",
  });
});

test("rejects the old workshop_ids contract before every dependency", async () => {
  const harness = createHarness();

  await assert.rejects(
    harness.useCase(CLIENT_TOKEN, { ...validRequest, workshop_ids: [20] }),
  );
  assert.equal(harness.vehicleCalls.length, 0);
  assert.equal(harness.serviceCalls.length, 0);
  assert.equal(harness.resolverQueries.length, 0);
  assert.equal(harness.snapshotQueries.length, 0);
});

test("returns the service name and one signed token for each of at most three options", async () => {
  const harness = createHarness();
  const result = await harness.useCase(CLIENT_TOKEN, validRequest);
  const verifier = createBookingSlotTokenService({
    secret: SLOT_SECRET,
    now: () => TODAY,
  });

  assert.ok("options" in result);
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
      version: 2,
      expiration: 1_786_363_800,
      vehicle_id: 14,
      service_type_id: 2,
      workshop_id: 20,
      showroom_id: 8,
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

  assert.ok("options" in result);
  assert.deepEqual(harness.snapshotQueries, [
    {
      workshopIds: [20],
      showroomId: 8,
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
  assert.equal(harness.serviceCalls.length, 0);
  assert.equal(harness.resolverQueries.length, 0);
  assert.equal(harness.snapshotQueries.length, 0);
});

test("rejects PEINT with mecanique before resolving workshops or reading occupancy", async () => {
  const harness = createHarness();

  await assert.rejects(
    harness.useCase(CLIENT_TOKEN, {
      ...validRequest,
      service_type_id: 5,
    }),
    (error: unknown) => {
      assert.ok(error instanceof BookingAvailabilityError);
      assert.equal(error.code, "BOOKING_AVAILABILITY_NOT_FOUND");
      return true;
    },
  );
  assert.equal(harness.resolverQueries.length, 0);
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

test("maps a showroom without a matching workshop to controlled no availability", async () => {
  const harness = createHarness({
    resolveWorkshops: async () => {
      throw new DirectusError("DIRECTUS_NOT_FOUND");
    },
  });

  await assert.rejects(
    harness.useCase(CLIENT_TOKEN, validRequest),
    (error: unknown) =>
      error instanceof BookingAvailabilityError &&
      error.code === "BOOKING_AVAILABILITY_NOT_FOUND",
  );
  assert.equal(harness.snapshotQueries.length, 0);
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
  assert.equal(harness.serviceCalls.length, 0);
  assert.equal(harness.resolverQueries.length, 0);
  assert.equal(harness.snapshotQueries.length, 0);
});

test("calendar resolves and loads the complete horizon exactly once without signing tokens", async () => {
  const harness = createHarness({ slotSecret: " " });
  const result = await harness.useCase(CLIENT_TOKEN, {
    vehicle_id: 14,
    service_type_id: 2,
    showroom_id: 8,
    workshop_types: ["mecanique"],
    result_mode: "calendar",
  });

  assert.ok("days" in result);
  assert.deepEqual(harness.resolverQueries, [
    { showroomId: 8, workshopTypes: ["mecanique"] },
  ]);
  assert.deepEqual(harness.snapshotQueries, [
    {
      workshopIds: [20],
      showroomId: 8,
      startDate: "2026-08-10",
      endDate: "2026-09-08",
    },
  ]);
  assert.equal(harness.vehicleCalls.length, 1);
  assert.equal(harness.serviceCalls.length, 1);
  assert.deepEqual(result.days, [
    {
      date: "2026-08-12",
      available_slot_count: 18,
      morning_slot_count: 8,
      afternoon_slot_count: 10,
    },
  ]);
  assert.equal(JSON.stringify(result).includes("slot_token"), false);
});

test("calendar preserves Tanger showroom isolation with physical workshop 24", async () => {
  const tangerWorkshop: ResolvedBookingWorkshop = {
    ...resolvedWorkshop,
    id: 24,
    name: "Atelier Tanger",
    workshop_type: "carrosserie",
    showroom: {
      ...resolvedWorkshop.showroom,
      id: 5,
      name: "Tanger",
      city: "Tanger",
    },
  };
  const harness = createHarness({
    resolveWorkshops: async () => [tangerWorkshop],
    bookingSnapshot: {
      workshops: [tangerWorkshop],
      schedules: [{ ...snapshot.schedules[0]!, workshop_id: 24 }],
      resources: [{ workshop_id: 24, active: true, daily_hours: 9 }],
      appointments: [],
    },
  });

  const result = await harness.useCase(CLIENT_TOKEN, {
    vehicle_id: 14,
    service_type_id: 4,
    showroom_id: 5,
    workshop_types: ["carrosserie"],
    result_mode: "calendar",
  });

  assert.ok("days" in result);
  assert.equal(result.days[0]?.available_slot_count, 18);
  assert.deepEqual(harness.resolverQueries, [
    { showroomId: 5, workshopTypes: ["carrosserie"] },
  ]);
  assert.deepEqual(harness.snapshotQueries, [
    {
      workshopIds: [24],
      showroomId: 5,
      startDate: "2026-08-10",
      endDate: "2026-09-08",
    },
  ]);
});
