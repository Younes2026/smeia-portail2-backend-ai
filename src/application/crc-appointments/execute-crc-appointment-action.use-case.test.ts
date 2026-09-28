import assert from "node:assert/strict";
import test from "node:test";

import type { DirectusBookingAvailabilitySnapshot } from "../../domain/ai-booking/index.js";
import type { CrcAppointmentStatus } from "../../domain/crc-appointments/index.js";
import type {
  DirectusBookingAvailabilityQuery,
  DirectusCrcAppointmentActionContext,
  DirectusCrcAppointmentActionsService,
  DirectusCrcAppointmentEventCreateInput,
  DirectusCrcAppointmentReplayEvent,
  DirectusCrcAppointmentSlotUpdate,
} from "../../infrastructure/directus/index.js";
import {
  CrcDirectusActionStepError,
  DirectusError,
} from "../../infrastructure/directus/index.js";
import {
  BookingAvailabilityError,
  type BookingSlotLock,
  type BookingSlotTokenPayload,
  type BookingSlotTokenService,
} from "../ai-booking/index.js";
import { CrcAppointmentActionError } from "./crc-appointment-action.errors.js";
import { createExecuteCrcAppointmentActionUseCase } from "./execute-crc-appointment-action.use-case.js";

const ACCESS_TOKEN = "unit-test-agent-token-placeholder";
const WRITE_TOKEN = "unit-test-write-token-placeholder";
const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const KEY_ONE = "123e4567-e89b-42d3-a456-426614174000";
const APPOINTMENT_ID = 42;
const NOW = new Date("2026-08-10T10:00:00.000Z");
const SLOT_TOKEN = "signed-slot-token-primary";
const SLOT_TOKEN_TWO = "signed-slot-token-secondary";
const INVALID_SLOT_TOKEN = "invalid-slot-token";
const EXPIRED_SLOT_TOKEN = "expired-slot-token";

const BASE_APPOINTMENT: DirectusCrcAppointmentActionContext = {
  id: APPOINTMENT_ID,
  status: "pending",
  requestedDate: "2026-08-11",
  requestedTime: "10:00:00",
  vehicleId: 14,
  serviceTypeId: 2,
  workshopId: 20,
  showroomId: 8,
};

const BASE_SLOT: BookingSlotTokenPayload = {
  version: 2,
  expiration: 1_800_000_000,
  vehicle_id: 14,
  service_type_id: 2,
  workshop_id: 20,
  showroom_id: 8,
  requested_date: "2026-08-12",
  requested_time: "08:00:00",
  slot_interval_minutes: 30,
};

const BASE_SNAPSHOT: DirectusBookingAvailabilitySnapshot = {
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
      total_capacity_hours: 9,
      used_capacity_hours: 0,
      remaining_capacity_hours: 9,
    },
  ],
  resources: [{ workshop_id: 20, active: true, daily_hours: 9 }],
  appointments: [],
};

const cloneSnapshot = (
  snapshot = BASE_SNAPSHOT,
): DirectusBookingAvailabilitySnapshot => structuredClone(snapshot);

const selectedConfirmBody = (slotToken = SLOT_TOKEN) => ({
  selection: { slot_token: slotToken },
  agreement_channel: "telephone" as const,
  internal_note: "Accord obtenu par telephone.",
});

type HarnessOptions = {
  writeToken?: string | undefined;
  appointmentMissing?: boolean;
  appointment?: Partial<DirectusCrcAppointmentActionContext>;
  forceConditionalConflict?: boolean;
  failHistory?: boolean;
  omitEventId?: boolean;
  snapshot?: DirectusBookingAvailabilitySnapshot;
  failSnapshot?: boolean;
  snapshotError?: unknown;
  persistentEvents?: Map<string, DirectusCrcAppointmentReplayEvent>;
};

const createHarness = (
  initialStatus: CrcAppointmentStatus = "pending",
  options: HarnessOptions = {},
) => {
  let currentAppointment: DirectusCrcAppointmentActionContext = {
    ...BASE_APPOINTMENT,
    status: initialStatus,
    ...options.appointment,
  };
  let statusReadCalls = 0;
  let contextReadCalls = 0;
  let eventLookupCalls = 0;
  const tokenVerifications: string[] = [];
  const lockKeys: string[] = [];
  const snapshotCalls: Array<{
    token: string;
    query: DirectusBookingAvailabilityQuery;
  }> = [];
  const updates: Array<{
    token: string;
    observedAppointment: Parameters<
      DirectusCrcAppointmentActionsService["updateAppointmentStatus"]
    >[1];
    targetStatus: CrcAppointmentStatus;
    slotUpdate?: DirectusCrcAppointmentSlotUpdate;
  }> = [];
  const eventInputs: DirectusCrcAppointmentEventCreateInput[] = [];
  const events =
    options.persistentEvents ??
    new Map<string, DirectusCrcAppointmentReplayEvent>();

  const actionService: DirectusCrcAppointmentActionsService = {
    async findEventByIdempotencyKey(token, key) {
      eventLookupCalls += 1;
      assert.equal(token, options.writeToken ?? WRITE_TOKEN);
      return events.get(key) ?? null;
    },
    async getAppointmentStatus(token, appointmentId) {
      statusReadCalls += 1;
      assert.equal(token, options.writeToken ?? WRITE_TOKEN);
      assert.equal(appointmentId, APPOINTMENT_ID);
      if (options.appointmentMissing === true) {
        return null;
      }
      return currentAppointment.status;
    },
    async getAppointment(token, appointmentId) {
      contextReadCalls += 1;
      assert.equal(token, options.writeToken ?? WRITE_TOKEN);
      assert.equal(appointmentId, APPOINTMENT_ID);
      if (options.appointmentMissing === true) {
        return null;
      }
      return { ...currentAppointment };
    },
    async updateAppointmentStatus(
      token,
      observedAppointment,
      targetStatus,
      slotUpdate,
    ) {
      updates.push({
        token,
        observedAppointment: { ...observedAppointment },
        targetStatus,
        ...(slotUpdate === undefined ? {} : { slotUpdate: { ...slotUpdate } }),
      });
      const observationStillMatches =
        currentAppointment.status === observedAppointment.status &&
        (!("requestedDate" in observedAppointment) ||
          (currentAppointment.requestedDate ===
            observedAppointment.requestedDate &&
            currentAppointment.requestedTime ===
              observedAppointment.requestedTime &&
            currentAppointment.workshopId === observedAppointment.workshopId));
      if (options.forceConditionalConflict === true || !observationStillMatches) {
        return false;
      }
      currentAppointment = {
        ...currentAppointment,
        status: targetStatus,
        requestedDate: slotUpdate?.requestedDate ?? currentAppointment.requestedDate,
        requestedTime: slotUpdate?.requestedTime ?? currentAppointment.requestedTime,
      };
      return true;
    },
    async createEvent(token, input) {
      assert.equal(token, options.writeToken ?? WRITE_TOKEN);
      eventInputs.push(input);
      if (options.failHistory === true) {
        throw new Error("simulated history failure");
      }
      const event: DirectusCrcAppointmentReplayEvent = {
        id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(eventInputs.length).padStart(12, "0")}`,
        appointment_id: input.appointment_id,
        event_type: input.event_type,
        status_from: input.status_from as "pending" | "callback_pending",
        status_to: input.status_to as
          | "callback_pending"
          | "rejected"
          | "confirmed",
        idempotency_key: input.idempotency_key,
        request_fingerprint: input.request_fingerprint,
      };
      events.set(input.idempotency_key, event);
      return options.omitEventId === true ? {} : { eventId: event.id };
    },
  };

  const tokenPayloads = new Map<string, BookingSlotTokenPayload>([
    [SLOT_TOKEN, BASE_SLOT],
    [SLOT_TOKEN_TWO, { ...BASE_SLOT, requested_time: "08:30:00" }],
  ]);
  const slotTokenService: BookingSlotTokenService = {
    assertConfigured() {},
    create() {
      throw new Error("slot creation is outside this use case");
    },
    verify(slotToken) {
      tokenVerifications.push(slotToken);
      if (slotToken === EXPIRED_SLOT_TOKEN) {
        throw new BookingAvailabilityError("BOOKING_SLOT_TOKEN_EXPIRED");
      }
      const payload = tokenPayloads.get(slotToken);
      if (slotToken === INVALID_SLOT_TOKEN || payload === undefined) {
        throw new BookingAvailabilityError("BOOKING_SLOT_TOKEN_INVALID");
      }
      return { ...payload };
    },
  };
  const slotLock: BookingSlotLock = {
    async withLock(key, operation) {
      lockKeys.push(key);
      return operation();
    },
    cleanup() {},
    getSize: () => 0,
  };

  const execute = createExecuteCrcAppointmentActionUseCase({
    actionService,
    getWriteToken: () =>
      Object.hasOwn(options, "writeToken")
        ? options.writeToken
        : WRITE_TOKEN,
    slotTokenService,
    slotLock,
    async getBookingSnapshot(token, query) {
      snapshotCalls.push({ token, query });
      if (options.snapshotError !== undefined) {
        throw options.snapshotError;
      }
      if (options.failSnapshot === true) {
        throw new Error("simulated availability failure");
      }
      return cloneSnapshot(options.snapshot);
    },
    now: () => NOW,
  });

  const run = (
    action: "callback" | "reject" | "confirm",
    body: unknown,
    idempotencyKey = KEY_ONE,
  ) =>
    execute({
      accessToken: ACCESS_TOKEN,
      actorUserId: ACTOR_ID,
      appointmentId: String(APPOINTMENT_ID),
      action,
      idempotencyKey,
      body,
    });

  return {
    run,
    updates,
    eventInputs,
    snapshotCalls,
    tokenVerifications,
    lockKeys,
    statusReadCalls: () => statusReadCalls,
    contextReadCalls: () => contextReadCalls,
    eventLookupCalls: () => eventLookupCalls,
    currentAppointment: () => ({ ...currentAppointment }),
  };
};

test("keeps the legacy confirm contract and does not invoke availability", async () => {
  const harness = createHarness();
  const result = await harness.run("confirm", {
    internal_note: " Confirmation historique ",
  });

  assert.deepEqual(result, {
    appointment_id: APPOINTMENT_ID,
    action: "confirm",
    status_from: "pending",
    status_to: "confirmed",
    event_id: "aaaaaaaa-aaaa-4aaa-8aaa-000000000001",
    history_recorded: true,
  });
  assert.equal(harness.snapshotCalls.length, 0);
  assert.equal(harness.lockKeys.length, 0);
  assert.equal(harness.statusReadCalls(), 1);
  assert.equal(harness.contextReadCalls(), 0);
  assert.equal(harness.updates.length, 1);
  assert.equal(harness.updates[0]?.slotUpdate, undefined);
  assert.equal(harness.eventInputs[0]?.internal_note, "Confirmation historique");
});

test("confirms a selected slot on the same pending or callback_pending appointment", async (t) => {
  for (const status of ["pending", "callback_pending"] as const) {
    await t.test(status, async () => {
      const harness = createHarness(status);
      const result = await harness.run("confirm", selectedConfirmBody());

      assert.deepEqual(result, {
        appointment_id: APPOINTMENT_ID,
        action: "confirm",
        status_from: status,
        status_to: "confirmed",
        event_id: "aaaaaaaa-aaaa-4aaa-8aaa-000000000001",
        history_recorded: true,
        previous_slot: { date: "2026-08-11", time: "10:00:00" },
        selected_slot: {
          date: "2026-08-12",
          time: "08:00:00",
          workshop_id: 20,
        },
        agreement_channel: "telephone",
      });
      assert.equal(harness.updates.length, 1);
      assert.equal(harness.statusReadCalls(), 0);
      assert.equal(harness.contextReadCalls(), 1);
      assert.equal(harness.updates[0]?.observedAppointment.id, APPOINTMENT_ID);
      assert.equal(harness.updates[0]?.targetStatus, "confirmed");
      assert.deepEqual(harness.updates[0]?.slotUpdate, {
        requestedDate: "2026-08-12",
        requestedTime: "08:00:00",
      });
      assert.deepEqual(harness.currentAppointment(), {
        ...BASE_APPOINTMENT,
        status: "confirmed",
        requestedDate: "2026-08-12",
        requestedTime: "08:00:00",
      });
      assert.equal(harness.eventInputs.length, 1);
      assert.equal(harness.eventInputs[0]?.appointment_id, APPOINTMENT_ID);
      assert.equal(harness.eventInputs[0]?.actor_user_id, ACTOR_ID);
    });
  }
});

test("requires telephone agreement for a selected confirmation before any read", async () => {
  const harness = createHarness();
  await assert.rejects(
    harness.run("confirm", { selection: { slot_token: SLOT_TOKEN } }),
  );
  assert.equal(harness.eventLookupCalls(), 0);
  assert.equal(harness.statusReadCalls(), 0);
  assert.equal(harness.contextReadCalls(), 0);
  assert.equal(harness.updates.length, 0);
});

test("rejects vehicle, service, showroom and workshop slot context mismatches", async (t) => {
  const cases: Array<{
    name: string;
    appointment: Partial<DirectusCrcAppointmentActionContext>;
  }> = [
    { name: "vehicle", appointment: { vehicleId: 15 } },
    { name: "service", appointment: { serviceTypeId: 3 } },
    { name: "showroom", appointment: { showroomId: 9 } },
    { name: "workshop", appointment: { workshopId: 21 } },
  ];
  for (const mismatch of cases) {
    await t.test(mismatch.name, async () => {
      const harness = createHarness("pending", {
        appointment: mismatch.appointment,
      });
      await assert.rejects(
        harness.run("confirm", selectedConfirmBody()),
        (error: unknown) =>
          error instanceof CrcAppointmentActionError &&
          error.code === "CRC_SLOT_CONTEXT_MISMATCH",
      );
      assert.equal(harness.snapshotCalls.length, 0);
      assert.equal(harness.updates.length, 0);
      assert.equal(harness.eventInputs.length, 0);
    });
  }
});

test("maps invalid and expired selected-slot tokens to CRC errors", async (t) => {
  for (const tokenCase of [
    { token: INVALID_SLOT_TOKEN, code: "CRC_SLOT_TOKEN_INVALID" },
    { token: EXPIRED_SLOT_TOKEN, code: "CRC_SLOT_TOKEN_EXPIRED" },
  ] as const) {
    await t.test(tokenCase.code, async () => {
      const harness = createHarness();
      await assert.rejects(
        harness.run("confirm", selectedConfirmBody(tokenCase.token)),
        (error: unknown) =>
          error instanceof CrcAppointmentActionError &&
          error.code === tokenCase.code,
      );
      assert.equal(harness.statusReadCalls(), 0);
      assert.equal(harness.contextReadCalls(), 0);
      assert.equal(harness.updates.length, 0);
      assert.equal(harness.eventInputs.length, 0);
    });
  }
});

test("revalidates the selected slot with the writer token and current appointment excluded", async () => {
  const harness = createHarness();
  await harness.run("confirm", selectedConfirmBody());

  assert.deepEqual(harness.snapshotCalls, [
    {
      token: WRITE_TOKEN,
      query: {
        workshopIds: [20],
        showroomId: 8,
        startDate: "2026-08-12",
        endDate: "2026-08-12",
        excludedAppointmentId: APPOINTMENT_ID,
      },
    },
  ]);
  assert.deepEqual(harness.lockKeys, ["20|2026-08-12|08:00:00"]);
});

test("does not patch or create history when the selected slot is no longer available", async () => {
  const unavailable = cloneSnapshot();
  unavailable.resources = [];
  const harness = createHarness("pending", { snapshot: unavailable });

  await assert.rejects(
    harness.run("confirm", selectedConfirmBody()),
    (error: unknown) =>
      error instanceof CrcAppointmentActionError &&
      error.code === "CRC_SLOT_NO_LONGER_AVAILABLE",
  );
  assert.equal(harness.snapshotCalls.length, 1);
  assert.equal(harness.updates.length, 0);
  assert.equal(harness.eventInputs.length, 0);
  assert.equal(harness.currentAppointment().status, "pending");
});

test("returns the same selected-confirmation result for the same key and rejects another selection", async () => {
  const harness = createHarness();
  const first = await harness.run("confirm", selectedConfirmBody());
  const replay = await harness.run("confirm", selectedConfirmBody());

  assert.deepEqual(replay, first);
  assert.equal(harness.updates.length, 1);
  assert.equal(harness.eventInputs.length, 1);
  assert.equal(harness.snapshotCalls.length, 1);
  assert.equal(harness.tokenVerifications.length, 1);

  await assert.rejects(
    harness.run("confirm", selectedConfirmBody(SLOT_TOKEN_TWO)),
    (error: unknown) =>
      error instanceof CrcAppointmentActionError &&
      error.code === "CRC_IDEMPOTENCY_CONFLICT",
  );
  assert.equal(harness.updates.length, 1);
  assert.equal(harness.eventInputs.length, 1);
});

test("cold replay of the same selected confirmation returns the documented minimal fallback", async () => {
  const persistentEvents = new Map<
    string,
    DirectusCrcAppointmentReplayEvent
  >();
  const warmInstance = createHarness("pending", { persistentEvents });
  const enrichedResult = await warmInstance.run(
    "confirm",
    selectedConfirmBody(),
  );
  assert.equal("selected_slot" in enrichedResult, true);

  const coldInstance = createHarness("confirmed", { persistentEvents });
  const replay = await coldInstance.run("confirm", selectedConfirmBody());

  assert.deepEqual(replay, {
    appointment_id: APPOINTMENT_ID,
    action: "confirm",
    status_from: "pending",
    status_to: "confirmed",
    event_id: "aaaaaaaa-aaaa-4aaa-8aaa-000000000001",
    history_recorded: true,
  });
  assert.equal(coldInstance.eventLookupCalls(), 1);
  assert.equal(coldInstance.statusReadCalls(), 0);
  assert.equal(coldInstance.contextReadCalls(), 0);
  assert.equal(coldInstance.tokenVerifications.length, 0);
  assert.equal(coldInstance.updates.length, 0);
  assert.equal(coldInstance.eventInputs.length, 0);
});

test("cold replay rejects another selected slot before any appointment read or write", async () => {
  const persistentEvents = new Map<
    string,
    DirectusCrcAppointmentReplayEvent
  >();
  const warmInstance = createHarness("pending", { persistentEvents });
  await warmInstance.run("confirm", selectedConfirmBody());

  const coldInstance = createHarness("confirmed", { persistentEvents });
  await assert.rejects(
    coldInstance.run("confirm", selectedConfirmBody(SLOT_TOKEN_TWO)),
    (error: unknown) =>
      error instanceof CrcAppointmentActionError &&
      error.code === "CRC_IDEMPOTENCY_CONFLICT",
  );
  assert.equal(coldInstance.eventLookupCalls(), 1);
  assert.equal(coldInstance.statusReadCalls(), 0);
  assert.equal(coldInstance.contextReadCalls(), 0);
  assert.equal(coldInstance.tokenVerifications.length, 0);
  assert.equal(coldInstance.updates.length, 0);
  assert.equal(coldInstance.eventInputs.length, 0);
});

test("rejects all terminal appointments before update or event creation", async () => {
  for (const status of [
    "confirmed",
    "rejected",
    "cancelled",
    "arrived",
  ] as const) {
    const harness = createHarness(status);
    await assert.rejects(
      harness.run("confirm", selectedConfirmBody()),
      (error: unknown) =>
        error instanceof CrcAppointmentActionError &&
        error.code === "CRC_APPOINTMENT_NOT_TREATABLE",
    );
    assert.equal(harness.updates.length, 0);
    assert.equal(harness.eventInputs.length, 0);
  }
});

test("reports a conditional transition conflict without writing history", async () => {
  const harness = createHarness("pending", { forceConditionalConflict: true });
  await assert.rejects(
    harness.run("confirm", selectedConfirmBody()),
    (error: unknown) =>
      error instanceof CrcAppointmentActionError &&
      error.code === "CRC_APPOINTMENT_CONFLICT",
  );
  assert.equal(harness.updates.length, 1);
  assert.equal(harness.eventInputs.length, 0);
  assert.equal(harness.currentAppointment().status, "pending");
});

test("reports non-atomic history failure after the selected slot update", async () => {
  const harness = createHarness("pending", { failHistory: true });
  await assert.rejects(
    harness.run("confirm", selectedConfirmBody()),
    (error: unknown) =>
      error instanceof CrcAppointmentActionError &&
      error.code === "CRC_HISTORY_WRITE_FAILED",
  );
  assert.equal(harness.updates.length, 1);
  assert.equal(harness.eventInputs.length, 1);
  assert.deepEqual(harness.currentAppointment(), {
    ...BASE_APPOINTMENT,
    status: "confirmed",
    requestedDate: "2026-08-12",
    requestedTime: "08:00:00",
  });
});

test("never passes the slot token to Directus or returns it in the API result", async () => {
  const harness = createHarness();
  const logs: unknown[][] = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  console.log = (...values: unknown[]) => logs.push(values);
  console.warn = (...values: unknown[]) => logs.push(values);
  console.error = (...values: unknown[]) => logs.push(values);
  let result: Awaited<ReturnType<typeof harness.run>>;
  try {
    result = await harness.run("confirm", selectedConfirmBody());
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
  }
  const directusAndResponseSurface = JSON.stringify({
    updates: harness.updates,
    events: harness.eventInputs,
    result,
    logs,
  });

  assert.equal(directusAndResponseSurface.includes(SLOT_TOKEN), false);
  assert.equal(directusAndResponseSurface.includes("slot_token"), false);
  assert.equal("selection" in (harness.eventInputs[0] ?? {}), false);
  assert.match(
    harness.eventInputs[0]?.request_fingerprint ?? "",
    /^[a-f0-9]{64}$/,
  );
});

test("preserves callback and reject payloads and callback replay", async () => {
  const callback = createHarness();
  const body = {
    callback_due_at: "2026-08-24T10:30:00+01:00",
    internal_note: " Client injoignable ",
  };
  const first = await callback.run("callback", body);
  const replay = await callback.run("callback", body);
  assert.deepEqual(replay, first);
  assert.equal(callback.currentAppointment().status, "callback_pending");
  assert.equal(callback.statusReadCalls(), 1);
  assert.equal(callback.contextReadCalls(), 0);
  assert.equal(callback.updates[0]?.slotUpdate, undefined);
  assert.equal(callback.eventInputs[0]?.internal_note, "Client injoignable");
  assert.equal(callback.eventInputs.length, 1);

  const reject = createHarness("callback_pending");
  const result = await reject.run("reject", {
    reason_code: "other",
    public_message: "La demande ne peut pas etre traitee.",
    internal_note: "Motif controle par le CRC.",
  });
  assert.equal(result.status_from, "callback_pending");
  assert.equal(result.status_to, "rejected");
  assert.equal(reject.statusReadCalls(), 1);
  assert.equal(reject.contextReadCalls(), 0);
  assert.equal(reject.eventInputs[0]?.reason_code, "other");
});

test("keeps configuration, not-found and minimal-history safeguards", async () => {
  await assert.rejects(
    createHarness("pending", { writeToken: undefined }).run("callback", {}),
    (error: unknown) =>
      error instanceof CrcAppointmentActionError &&
      error.code === "CRC_WRITE_CONFIGURATION_UNAVAILABLE",
  );
  await assert.rejects(
    createHarness("pending", { appointmentMissing: true }).run("callback", {}),
    (error: unknown) =>
      error instanceof CrcAppointmentActionError &&
      error.code === "CRC_APPOINTMENT_NOT_FOUND",
  );
  const noEventId = createHarness("pending", { omitEventId: true });
  assert.deepEqual(await noEventId.run("callback", {}), {
    appointment_id: APPOINTMENT_ID,
    action: "callback",
    status_from: "pending",
    status_to: "callback_pending",
    history_recorded: true,
  });
});

test("maps availability reader failures without updating the appointment", async () => {
  const harness = createHarness("pending", { failSnapshot: true });
  await assert.rejects(
    harness.run("confirm", selectedConfirmBody()),
    (error: unknown) =>
      error instanceof CrcAppointmentActionError &&
      error.code === "CRC_SLOT_VALIDATION_UNAVAILABLE",
  );
  assert.equal(harness.updates.length, 0);
  assert.equal(harness.eventInputs.length, 0);
});

test("keeps the Directus revalidation step identifiable without updating", async () => {
  const harness = createHarness("pending", {
    snapshotError: new DirectusError("DIRECTUS_INVALID_RESPONSE", 200, {
      directus_http_status: 200,
      response_kind: "json",
      data_kind: "array",
      data_length: 1,
      field_names: ["requested_date", "requested_time", "workshop_id"],
    }),
  });

  await assert.rejects(
    harness.run("confirm", selectedConfirmBody()),
    (error: unknown) => {
      assert.ok(error instanceof CrcDirectusActionStepError);
      assert.equal(error.step, "CRC_SLOT_REVALIDATE");
      assert.equal(error.code, "DIRECTUS_INVALID_RESPONSE");
      assert.equal(error.diagnostic?.data_kind, "array");
      return true;
    },
  );
  assert.equal(harness.updates.length, 0);
  assert.equal(harness.eventInputs.length, 0);
});

test("rejects malformed action inputs before appointment reads", async () => {
  const harness = createHarness();
  await assert.rejects(harness.run("callback", {}, "missing-key"));
  await assert.rejects(harness.run("reject", { reason_code: "other" }));
  assert.equal(harness.statusReadCalls(), 0);
  assert.equal(harness.contextReadCalls(), 0);
  assert.equal(harness.updates.length, 0);
});
