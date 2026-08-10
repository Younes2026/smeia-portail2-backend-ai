import assert from "node:assert/strict";
import test from "node:test";

import type { DirectusBookingAvailabilitySnapshot } from "../../domain/ai-booking/index.js";
import {
  DirectusError,
  type DirectusAiCatalogs,
  type DirectusAppointmentCreateInput,
} from "../../infrastructure/directus/index.js";
import { BookingConfirmationError } from "./booking-confirmation-errors.js";
import { createBookingIdempotencyStore } from "./booking-idempotency.store.js";
import { createBookingSlotLock } from "./booking-slot-lock.js";
import { createBookingSlotTokenService } from "./booking-slot-token.service.js";
import { createConfirmAppointmentUseCase } from "./confirm-appointment.use-case.js";

const CLIENT_TOKEN = "unit-test-client-token-placeholder";
const SLOT_SECRET = "unit-test-booking-slot-secret-placeholder";
const NOW = new Date("2026-08-10T12:00:00.000Z");
const KEY_ONE = "00000000-0000-4000-8000-000000000001";
const KEY_TWO = "00000000-0000-4000-8000-000000000002";

const catalogs: DirectusAiCatalogs = {
  available_services: [
    { id: 2, name: "Diagnostic", code: "MEC-DIAG B" },
  ],
  available_workshops: [
    { id: 1, name: "Atelier Rapide", workshop_type: "diagnostic" },
  ],
};

const baseSnapshot: DirectusBookingAvailabilitySnapshot = {
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
      total_capacity_hours: 9,
      used_capacity_hours: 0,
      remaining_capacity_hours: 9,
    },
  ],
  resources: [{ workshop_id: 1, active: true, daily_hours: 9 }],
  appointments: [],
};

const confirmationBody = (slotToken: string, summary = "Voyant moteur allume.") => ({
  slot_token: slotToken,
  problem_summary: summary,
  confirmation: true as const,
});

type HarnessOptions = {
  snapshot?: DirectusBookingAvailabilitySnapshot;
  getVehicle?: () => Promise<{
    vehicleId: number;
    customerId: number;
    label: string;
  }>;
  getCatalogs?: () => Promise<DirectusAiCatalogs>;
  create?: (
    accessToken: string,
    input: DirectusAppointmentCreateInput,
  ) => Promise<{ appointmentId: number; status: "pending" }>;
};

const createHarness = (options: HarnessOptions = {}) => {
  const slotTokenService = createBookingSlotTokenService({
    secret: SLOT_SECRET,
    now: () => NOW,
  });
  const createdInputs: Array<{
    accessToken: string;
    input: DirectusAppointmentCreateInput;
  }> = [];
  const vehicleCalls: Array<{ accessToken: string; vehicleId: unknown }> = [];
  const snapshotQueries: unknown[] = [];
  const useCase = createConfirmAppointmentUseCase({
    slotTokenService,
    idempotencyStore: createBookingIdempotencyStore({
      now: () => NOW,
      ttlMs: 60_000,
      maxEntries: 100,
    }),
    slotLock: createBookingSlotLock({
      now: () => NOW,
      idleTtlMs: 60_000,
      maxKeys: 100,
    }),
    async getBookingVehicleIdentity(accessToken, vehicleId) {
      vehicleCalls.push({ accessToken, vehicleId });
      return options.getVehicle?.() ?? {
        vehicleId: 14,
        customerId: 55,
        label: "BMW X1",
      };
    },
    async getAiCatalogs() {
      return options.getCatalogs?.() ?? catalogs;
    },
    async getBookingSnapshot(query) {
      snapshotQueries.push(query);
      return options.snapshot ?? baseSnapshot;
    },
    async createAppointment(accessToken, input) {
      createdInputs.push({ accessToken, input });
      return options.create?.(accessToken, input) ?? {
        appointmentId: 123,
        status: "pending",
      };
    },
    now: () => NOW,
  });
  const slotToken = slotTokenService.create({
    vehicle_id: 14,
    service_type_id: 2,
    workshop_id: 1,
    requested_date: "2026-08-12",
    requested_time: "09:30:00",
    slot_interval_minutes: 30,
  }).slotToken;

  return {
    createdInputs,
    slotToken,
    snapshotQueries,
    useCase,
    vehicleCalls,
  };
};

test("revalidates the signed slot and creates an exact pending appointment", async () => {
  const harness = createHarness();
  const result = await harness.useCase(
    CLIENT_TOKEN,
    KEY_ONE,
    confirmationBody(harness.slotToken),
  );

  assert.deepEqual(harness.vehicleCalls, [
    { accessToken: CLIENT_TOKEN, vehicleId: 14 },
  ]);
  assert.deepEqual(harness.snapshotQueries, [
    {
      workshopIds: [1],
      startDate: "2026-08-12",
      endDate: "2026-08-12",
    },
  ]);
  assert.deepEqual(harness.createdInputs, [
    {
      accessToken: CLIENT_TOKEN,
      input: {
        customer_id: 55,
        vehicle_id: 14,
        service_type_id: 2,
        workshop_id: 1,
        requested_date: "2026-08-12",
        requested_time: "09:30:00",
        comment: "Voyant moteur allume.",
      },
    },
  ]);
  assert.deepEqual(result, {
    appointment_id: 123,
    status: "pending",
    vehicle: { id: 14, label: "BMW X1" },
    service_type: { id: 2, name: "Diagnostic" },
    workshop: { id: 1, name: "Atelier Rapide" },
    showroom: baseSnapshot.workshops[0]?.showroom,
    requested_date: "2026-08-12",
    requested_time: "09:30:00",
    problem_summary: "Voyant moteur allume.",
  });
  assert.equal(Object.hasOwn(result, "customer_id"), false);
  assert.equal(Object.hasOwn(result, "slot_token"), false);
});

test("never uses a technical read token to verify vehicle ownership", async () => {
  const harness = createHarness({
    getVehicle: async () => {
      throw new DirectusError("DIRECTUS_VEHICLE_NOT_ACCESSIBLE");
    },
  });

  await assert.rejects(
    harness.useCase(
      CLIENT_TOKEN,
      KEY_ONE,
      confirmationBody(harness.slotToken),
    ),
    (error: unknown) =>
      error instanceof DirectusError &&
      error.code === "DIRECTUS_VEHICLE_NOT_ACCESSIBLE",
  );
  assert.deepEqual(harness.vehicleCalls, [
    { accessToken: CLIENT_TOKEN, vehicleId: 14 },
  ]);
  assert.equal(harness.createdInputs.length, 0);
});

test("rejects tampered and expired offers before creating", async () => {
  const invalidHarness = createHarness();
  await assert.rejects(
    invalidHarness.useCase(
      CLIENT_TOKEN,
      KEY_ONE,
      confirmationBody(`${invalidHarness.slotToken}x`),
    ),
    (error: unknown) =>
      error instanceof BookingConfirmationError &&
      error.code === "INVALID_SLOT_TOKEN",
  );
  assert.equal(invalidHarness.createdInputs.length, 0);

  const expiredTokenService = createBookingSlotTokenService({
    secret: SLOT_SECRET,
    now: () => new Date("2026-08-10T11:00:00.000Z"),
  });
  const expiredToken = expiredTokenService.create({
    vehicle_id: 14,
    service_type_id: 2,
    workshop_id: 1,
    requested_date: "2026-08-12",
    requested_time: "09:30:00",
    slot_interval_minutes: 30,
  }).slotToken;
  const expiredHarness = createHarness();
  await assert.rejects(
    expiredHarness.useCase(
      CLIENT_TOKEN,
      KEY_ONE,
      confirmationBody(expiredToken),
    ),
    (error: unknown) =>
      error instanceof BookingConfirmationError &&
      error.code === "SLOT_OFFER_EXPIRED",
  );
  assert.equal(expiredHarness.createdInputs.length, 0);
});

test("rejects changed catalog context and unavailable slots without creating", async () => {
  const contextHarness = createHarness({
    getCatalogs: async () => ({
      available_services: [],
      available_workshops: [],
    }),
  });
  await assert.rejects(
    contextHarness.useCase(
      CLIENT_TOKEN,
      KEY_ONE,
      confirmationBody(contextHarness.slotToken),
    ),
    (error: unknown) =>
      error instanceof BookingConfirmationError &&
      error.code === "BOOKING_CONTEXT_INVALID",
  );
  assert.equal(contextHarness.createdInputs.length, 0);

  const fullHarness = createHarness({
    snapshot: {
      ...baseSnapshot,
      appointments: [
        {
          workshop_id: 1,
          requested_date: "2026-08-12",
          requested_time: "09:30:00",
          status: "pending",
        },
      ],
    },
  });
  await assert.rejects(
    fullHarness.useCase(
      CLIENT_TOKEN,
      KEY_ONE,
      confirmationBody(fullHarness.slotToken),
    ),
    (error: unknown) =>
      error instanceof BookingConfirmationError &&
      error.code === "SLOT_NO_LONGER_AVAILABLE",
  );
  assert.equal(fullHarness.createdInputs.length, 0);
});

test("rejects inactive, closed and capacity-invalid contexts without creating", async () => {
  const snapshots: DirectusBookingAvailabilitySnapshot[] = [
    {
      ...baseSnapshot,
      workshops: [{ ...baseSnapshot.workshops[0]!, active: false }],
    },
    {
      ...baseSnapshot,
      workshops: [{ ...baseSnapshot.workshops[0]!, client_bookable: false }],
    },
    {
      ...baseSnapshot,
      workshops: [{ ...baseSnapshot.workshops[0]!, working_days: ["monday"] }],
    },
    { ...baseSnapshot, schedules: [] },
    {
      ...baseSnapshot,
      schedules: [
        {
          ...baseSnapshot.schedules[0]!,
          remaining_capacity_hours: 0,
        },
      ],
    },
    { ...baseSnapshot, resources: [] },
  ];

  for (const snapshot of snapshots) {
    const harness = createHarness({ snapshot });
    await assert.rejects(
      harness.useCase(
        CLIENT_TOKEN,
        KEY_ONE,
        confirmationBody(harness.slotToken),
      ),
      (error: unknown) =>
        error instanceof BookingConfirmationError &&
        (error.code === "BOOKING_CONTEXT_INVALID" ||
          error.code === "SLOT_NO_LONGER_AVAILABLE"),
    );
    assert.equal(harness.createdInputs.length, 0);
  }
});

test("replays identical idempotent requests but rejects a changed body", async () => {
  const harness = createHarness();
  const body = confirmationBody(harness.slotToken);
  const [first, replay] = await Promise.all([
    harness.useCase(CLIENT_TOKEN, KEY_ONE, body),
    harness.useCase(CLIENT_TOKEN, KEY_ONE, body),
  ]);
  assert.deepEqual(replay, first);
  assert.equal(harness.createdInputs.length, 1);

  await assert.rejects(
    harness.useCase(
      CLIENT_TOKEN,
      KEY_ONE,
      confirmationBody(harness.slotToken, "Autre resume suffisamment long."),
    ),
    (error: unknown) =>
      error instanceof BookingConfirmationError &&
      error.code === "IDEMPOTENCY_CONFLICT",
  );
  assert.equal(harness.createdInputs.length, 1);
});

test("serializes concurrent confirmations for the same last place", async () => {
  const appointments: DirectusBookingAvailabilitySnapshot["appointments"] = [];
  const slotTokenService = createBookingSlotTokenService({
    secret: SLOT_SECRET,
    now: () => NOW,
  });
  let creates = 0;
  const useCase = createConfirmAppointmentUseCase({
    slotTokenService,
    idempotencyStore: createBookingIdempotencyStore({
      now: () => NOW,
      ttlMs: 60_000,
      maxEntries: 100,
    }),
    slotLock: createBookingSlotLock({
      now: () => NOW,
      idleTtlMs: 60_000,
      maxKeys: 100,
    }),
    async getBookingVehicleIdentity() {
      return { vehicleId: 14, customerId: 55, label: "BMW X1" };
    },
    async getAiCatalogs() {
      return catalogs;
    },
    async getBookingSnapshot() {
      return { ...baseSnapshot, appointments: [...appointments] };
    },
    async createAppointment() {
      creates += 1;
      await new Promise<void>((resolve) => setImmediate(resolve));
      appointments.push({
        workshop_id: 1,
        requested_date: "2026-08-12",
        requested_time: "09:30:00",
        status: "pending",
      });
      return { appointmentId: 123, status: "pending" };
    },
    now: () => NOW,
  });
  const token = slotTokenService.create({
    vehicle_id: 14,
    service_type_id: 2,
    workshop_id: 1,
    requested_date: "2026-08-12",
    requested_time: "09:30:00",
    slot_interval_minutes: 30,
  }).slotToken;

  const results = await Promise.allSettled([
    useCase(CLIENT_TOKEN, KEY_ONE, confirmationBody(token)),
    useCase(CLIENT_TOKEN, KEY_TWO, confirmationBody(token)),
  ]);

  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(creates, 1);
  const rejected = results.find((result) => result.status === "rejected");
  assert.ok(rejected?.status === "rejected");
  assert.ok(rejected.reason instanceof BookingConfirmationError);
  assert.equal(rejected.reason.code, "SLOT_NO_LONGER_AVAILABLE");
});
