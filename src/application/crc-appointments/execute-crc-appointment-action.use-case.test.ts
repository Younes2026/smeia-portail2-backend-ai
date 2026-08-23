import assert from "node:assert/strict";
import test from "node:test";

import type { CrcAppointmentStatus } from "../../domain/crc-appointments/index.js";
import type {
  DirectusCrcAppointmentActionsService,
  DirectusCrcAppointmentEventCreateInput,
  DirectusCrcAppointmentReplayEvent,
} from "../../infrastructure/directus/index.js";
import { CrcAppointmentActionError } from "./crc-appointment-action.errors.js";
import { createExecuteCrcAppointmentActionUseCase } from "./execute-crc-appointment-action.use-case.js";

const ACCESS_TOKEN = "unit-test-agent-token-placeholder";
const WRITE_TOKEN = "unit-test-write-token-placeholder";
const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const KEY_ONE = "123e4567-e89b-42d3-a456-426614174000";
const KEY_TWO = "123e4567-e89b-42d3-a456-426614174001";

const createHarness = (
  initialStatus: CrcAppointmentStatus = "pending",
  options: {
    writeToken?: string | undefined;
    appointmentMissing?: boolean;
    forceConditionalConflict?: boolean;
    failHistory?: boolean;
    omitEventId?: boolean;
  } = {},
) => {
  let currentStatus = initialStatus;
  let getCalls = 0;
  const updates: Array<{
    token: string;
    observedStatus: CrcAppointmentStatus;
    targetStatus: CrcAppointmentStatus;
  }> = [];
  const eventInputs: DirectusCrcAppointmentEventCreateInput[] = [];
  const events = new Map<string, DirectusCrcAppointmentReplayEvent>();

  const actionService: DirectusCrcAppointmentActionsService = {
    async findEventByIdempotencyKey(token, key) {
      assert.equal(token, options.writeToken ?? WRITE_TOKEN);
      return events.get(key) ?? null;
    },
    async getAppointmentStatus(token, appointmentId) {
      getCalls += 1;
      assert.equal(token, options.writeToken ?? WRITE_TOKEN);
      assert.equal(appointmentId, 42);
      if (options.appointmentMissing === true) {
        return null;
      }
      return currentStatus;
    },
    async updateAppointmentStatus(
      token,
      _appointmentId,
      observedStatus,
      targetStatus,
    ) {
      updates.push({ token, observedStatus, targetStatus });
      if (
        options.forceConditionalConflict === true ||
        currentStatus !== observedStatus
      ) {
        return false;
      }
      currentStatus = targetStatus;
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

  const execute = createExecuteCrcAppointmentActionUseCase({
    actionService,
    getWriteToken: () =>
      Object.hasOwn(options, "writeToken")
        ? options.writeToken
        : WRITE_TOKEN,
  });

  const run = (
    action: "callback" | "reject" | "confirm",
    body: unknown,
    idempotencyKey = KEY_ONE,
  ) =>
    execute({
      accessToken: ACCESS_TOKEN,
      actorUserId: ACTOR_ID,
      appointmentId: "42",
      action,
      idempotencyKey,
      body,
    });

  return {
    run,
    updates,
    eventInputs,
    getCalls: () => getCalls,
    currentStatus: () => currentStatus,
  };
};

test("moves a pending appointment to callback_pending and replays its event", async () => {
  const harness = createHarness();
  const body = {
    callback_due_at: "2026-08-24T10:30:00+01:00",
    internal_note: " Client injoignable ",
  };
  const first = await harness.run("callback", body);
  const replay = await harness.run("callback", body);

  assert.deepEqual(replay, first);
  assert.deepEqual(first, {
    appointment_id: 42,
    action: "callback",
    status_from: "pending",
    status_to: "callback_pending",
    event_id: "aaaaaaaa-aaaa-4aaa-8aaa-000000000001",
    history_recorded: true,
  });
  assert.equal(harness.currentStatus(), "callback_pending");
  assert.equal(harness.updates.length, 1);
  assert.equal(harness.eventInputs.length, 1);
  assert.equal(harness.eventInputs[0]?.actor_user_id, ACTOR_ID);
  assert.equal(harness.eventInputs[0]?.internal_note, "Client injoignable");
  assert.match(
    harness.eventInputs[0]?.request_fingerprint ?? "",
    /^[a-f0-9]{64}$/,
  );
  assert.equal(harness.getCalls(), 1);

  await assert.rejects(
    harness.run("callback", { internal_note: "Autre requête" }),
    (error: unknown) =>
      error instanceof CrcAppointmentActionError &&
      error.code === "CRC_IDEMPOTENCY_CONFLICT",
  );
  assert.equal(harness.updates.length, 1);
});

test("deduplicates simultaneous requests with the same idempotency key", async () => {
  const harness = createHarness();
  const body = { internal_note: "Client injoignable" };
  const [first, second] = await Promise.all([
    harness.run("callback", body),
    harness.run("callback", body),
  ]);
  assert.deepEqual(second, first);
  assert.equal(harness.updates.length, 1);
  assert.equal(harness.eventInputs.length, 1);
});

test("returns successful minimal history when Directus omits the event ID", async () => {
  const harness = createHarness("pending", { omitEventId: true });
  assert.deepEqual(await harness.run("callback", {}), {
    appointment_id: 42,
    action: "callback",
    status_from: "pending",
    status_to: "callback_pending",
    history_recorded: true,
  });
  assert.equal(harness.eventInputs.length, 1);
});

test("records repeated callback attempts from callback_pending with new keys", async () => {
  const harness = createHarness("callback_pending");
  await harness.run("callback", {}, KEY_ONE);
  await harness.run(
    "callback",
    { internal_note: "Deuxième appel sans réponse" },
    KEY_TWO,
  );
  assert.equal(harness.updates.length, 2);
  assert.equal(harness.eventInputs.length, 2);
  assert.equal(harness.eventInputs[1]?.status_from, "callback_pending");
  assert.equal(harness.eventInputs[1]?.status_to, "callback_pending");
});

test("rejects and confirms from the two treatable statuses", async () => {
  const rejected = createHarness("callback_pending");
  const rejectResult = await rejected.run("reject", {
    reason_code: "other",
    public_message: "La demande ne peut pas être traitée.",
    internal_note: "Motif contrôlé par le CRC.",
  });
  assert.equal(rejectResult.action, "reject");
  assert.equal(rejectResult.status_to, "rejected");
  assert.equal(rejectResult.history_recorded, true);
  assert.equal(rejected.eventInputs[0]?.reason_code, "other");

  const confirmed = createHarness("pending");
  const confirmResult = await confirmed.run("confirm", {
    internal_note: "Confirmation démo sans contrôle de disponibilité.",
  });
  assert.equal(confirmResult.action, "confirm");
  assert.equal(confirmResult.status_to, "confirmed");
  assert.equal(confirmResult.history_recorded, true);
  assert.deepEqual(confirmed.updates[0], {
    token: WRITE_TOKEN,
    observedStatus: "pending",
    targetStatus: "confirmed",
  });
});

test("rejects missing configuration, missing appointments and terminal statuses", async () => {
  await assert.rejects(
    createHarness("pending", { writeToken: undefined }).run("callback", {}),
    (error: unknown) =>
      error instanceof CrcAppointmentActionError &&
      error.code === "CRC_WRITE_CONFIGURATION_UNAVAILABLE",
  );
  await assert.rejects(
    createHarness("pending", { appointmentMissing: true }).run(
      "callback",
      {},
    ),
    (error: unknown) =>
      error instanceof CrcAppointmentActionError &&
      error.code === "CRC_APPOINTMENT_NOT_FOUND",
  );
  for (const status of ["confirmed", "rejected", "cancelled", "arrived"] as const) {
    await assert.rejects(
      createHarness(status).run("callback", {}),
      (error: unknown) =>
        error instanceof CrcAppointmentActionError &&
        error.code === "CRC_APPOINTMENT_NOT_TREATABLE",
    );
  }
});

test("reports conditional races and non-atomic history failures explicitly", async () => {
  const conflict = createHarness("pending", {
    forceConditionalConflict: true,
  });
  await assert.rejects(
    conflict.run("reject", { reason_code: "service_unavailable" }),
    (error: unknown) =>
      error instanceof CrcAppointmentActionError &&
      error.code === "CRC_APPOINTMENT_CONFLICT",
  );
  assert.equal(conflict.eventInputs.length, 0);

  const historyFailure = createHarness("pending", { failHistory: true });
  await assert.rejects(
    historyFailure.run("callback", {}),
    (error: unknown) =>
      error instanceof CrcAppointmentActionError &&
      error.code === "CRC_HISTORY_WRITE_FAILED",
  );
  assert.equal(historyFailure.currentStatus(), "callback_pending");
  assert.equal(historyFailure.eventInputs.length, 1);
});

test("rejects missing idempotency keys and invalid action bodies before reads", async () => {
  const harness = createHarness();
  await assert.rejects(
    harness.run("callback", {}, "missing-key"),
  );
  await assert.rejects(
    harness.run("reject", { reason_code: "other" }),
  );
  assert.equal(harness.getCalls(), 0);
  assert.equal(harness.updates.length, 0);
});
