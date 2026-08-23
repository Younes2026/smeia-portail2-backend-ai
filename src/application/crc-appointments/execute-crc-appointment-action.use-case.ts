import { createHash } from "node:crypto";

import {
  CrcAppointmentActionResultSchema,
  CrcAppointmentActionSchema,
  CrcAppointmentIdParameterSchema,
  CrcCallbackActionBodySchema,
  CrcConfirmActionBodySchema,
  CrcIdempotencyKeySchema,
  CrcRejectActionBodySchema,
  type CrcAppointmentAction,
  type CrcAppointmentActionResult,
  type CrcAppointmentStatus,
} from "../../domain/crc-appointments/index.js";
import {
  DirectusError,
  crcAppointmentActionsService,
  type CrcEventType,
  type DirectusCrcAppointmentActionsService,
  type DirectusCrcAppointmentEventCreateInput,
  type DirectusCrcAppointmentEventCreateResult,
  type DirectusCrcAppointmentReplayEvent,
} from "../../infrastructure/directus/index.js";
import { env } from "../../config/env.js";
import { CrcAppointmentActionError } from "./crc-appointment-action.errors.js";

type ParsedActionBody =
  | ReturnType<typeof CrcCallbackActionBodySchema.parse>
  | ReturnType<typeof CrcRejectActionBodySchema.parse>
  | ReturnType<typeof CrcConfirmActionBodySchema.parse>;

export type ExecuteCrcAppointmentActionInput = {
  accessToken: string;
  actorUserId: string;
  appointmentId: unknown;
  action: unknown;
  idempotencyKey: unknown;
  body: unknown;
};

export type ExecuteCrcAppointmentActionUseCaseDependencies = {
  actionService: DirectusCrcAppointmentActionsService;
  getWriteToken(): string | undefined;
};

export type ExecuteCrcAppointmentActionUseCase = (
  input: ExecuteCrcAppointmentActionInput,
) => Promise<CrcAppointmentActionResult>;

const targetsByAction = {
  callback: "callback_pending",
  reject: "rejected",
  confirm: "confirmed",
} as const satisfies Record<CrcAppointmentAction, CrcAppointmentStatus>;

const eventTypesByAction = {
  callback: "callback_requested",
  reject: "rejected",
  confirm: "confirmed",
} as const satisfies Record<CrcAppointmentAction, CrcEventType>;

const actionsByEventType = {
  callback_requested: "callback",
  rejected: "reject",
  confirmed: "confirm",
} as const satisfies Record<CrcEventType, CrcAppointmentAction>;

const parseBody = (action: CrcAppointmentAction, body: unknown) => {
  if (action === "callback") {
    return CrcCallbackActionBodySchema.parse(body ?? {});
  }
  if (action === "reject") {
    return CrcRejectActionBodySchema.parse(body);
  }
  return CrcConfirmActionBodySchema.parse(body ?? {});
};

const fingerprintRequest = (
  actorUserId: string,
  appointmentId: number,
  action: CrcAppointmentAction,
  body: ParsedActionBody,
) =>
  createHash("sha256")
    .update(
      JSON.stringify({
        actor_user_id: actorUserId,
        appointment_id: appointmentId,
        action,
        body,
      }),
      "utf8",
    )
    .digest("hex");

const buildActionResult = (input: {
  appointmentId: number;
  action: CrcAppointmentAction;
  statusFrom: "pending" | "callback_pending";
  statusTo: "callback_pending" | "rejected" | "confirmed";
  eventId?: string;
}) => {
  const parsed = CrcAppointmentActionResultSchema.safeParse({
    appointment_id: input.appointmentId,
    action: input.action,
    status_from: input.statusFrom,
    status_to: input.statusTo,
    ...(input.eventId === undefined ? {} : { event_id: input.eventId }),
    history_recorded: true,
  });
  if (!parsed.success) {
    throw new DirectusError("DIRECTUS_INVALID_RESPONSE");
  }
  return parsed.data;
};

const resultFromEvent = (
  event: DirectusCrcAppointmentReplayEvent,
  expectedFingerprint: string,
) => {
  if (event.request_fingerprint !== expectedFingerprint) {
    throw new CrcAppointmentActionError("CRC_IDEMPOTENCY_CONFLICT");
  }
  return buildActionResult({
    appointmentId: event.appointment_id,
    action: actionsByEventType[event.event_type],
    statusFrom: event.status_from,
    statusTo: event.status_to,
    eventId: event.id,
  });
};

const eventInputFromAction = (
  appointmentId: number,
  actorUserId: string,
  action: CrcAppointmentAction,
  body: ParsedActionBody,
  statusFrom: "pending" | "callback_pending",
  idempotencyKey: string,
  requestFingerprint: string,
): DirectusCrcAppointmentEventCreateInput => {
  const common = {
    appointment_id: appointmentId,
    event_type: eventTypesByAction[action],
    actor_user_id: actorUserId,
    status_from: statusFrom,
    status_to: targetsByAction[action],
    idempotency_key: idempotencyKey,
    request_fingerprint: requestFingerprint,
  };

  if (action === "callback") {
    const callbackBody = CrcCallbackActionBodySchema.parse(body);
    return {
      ...common,
      ...(callbackBody.callback_due_at === undefined
        ? {}
        : { callback_due_at: callbackBody.callback_due_at }),
      ...(callbackBody.internal_note === undefined
        ? {}
        : { internal_note: callbackBody.internal_note }),
    };
  }
  if (action === "reject") {
    const rejectBody = CrcRejectActionBodySchema.parse(body);
    return {
      ...common,
      reason_code: rejectBody.reason_code,
      ...(rejectBody.public_message === undefined
        ? {}
        : { public_message: rejectBody.public_message }),
      ...(rejectBody.internal_note === undefined
        ? {}
        : { internal_note: rejectBody.internal_note }),
    };
  }
  const confirmBody = CrcConfirmActionBodySchema.parse(body);
  return {
    ...common,
    ...(confirmBody.internal_note === undefined
      ? {}
      : { internal_note: confirmBody.internal_note }),
  };
};

export const createExecuteCrcAppointmentActionUseCase = (
  dependencies: ExecuteCrcAppointmentActionUseCaseDependencies,
): ExecuteCrcAppointmentActionUseCase => {
  const inFlight = new Map<
    string,
    {
      requestFingerprint: string;
      promise: Promise<CrcAppointmentActionResult>;
    }
  >();

  return async (rawInput) => {
    const appointmentId = CrcAppointmentIdParameterSchema.parse(
      rawInput.appointmentId,
    );
    const action = CrcAppointmentActionSchema.parse(rawInput.action);
    const idempotencyKey = CrcIdempotencyKeySchema.parse(
      rawInput.idempotencyKey,
    );
    const actorUserId = CrcIdempotencyKeySchema.parse(rawInput.actorUserId);
    const body = parseBody(action, rawInput.body);
    const writeToken = dependencies.getWriteToken()?.trim();
    if (writeToken === undefined || writeToken.length === 0) {
      throw new CrcAppointmentActionError(
        "CRC_WRITE_CONFIGURATION_UNAVAILABLE",
      );
    }

    const requestFingerprint = fingerprintRequest(
      actorUserId,
      appointmentId,
      action,
      body,
    );
    const inFlightKey = createHash("sha256")
      .update(`${actorUserId}\0${idempotencyKey}`, "utf8")
      .digest("hex");
    const activeRequest = inFlight.get(inFlightKey);
    if (activeRequest !== undefined) {
      if (activeRequest.requestFingerprint !== requestFingerprint) {
        throw new CrcAppointmentActionError("CRC_IDEMPOTENCY_CONFLICT");
      }
      return activeRequest.promise;
    }

    const operation = (async () => {
      const existingEvent =
        await dependencies.actionService.findEventByIdempotencyKey(
          writeToken,
          idempotencyKey,
        );
      if (existingEvent !== null) {
        return resultFromEvent(existingEvent, requestFingerprint);
      }

      const observedStatus =
        await dependencies.actionService.getAppointmentStatus(
          writeToken,
          appointmentId,
        );
      if (observedStatus === null) {
        throw new CrcAppointmentActionError("CRC_APPOINTMENT_NOT_FOUND");
      }
      if (
        observedStatus !== "pending" &&
        observedStatus !== "callback_pending"
      ) {
        throw new CrcAppointmentActionError("CRC_APPOINTMENT_NOT_TREATABLE");
      }

      // Phase 1B demo scope: confirmation intentionally changes only the status.
      // Availability must be revalidated before this endpoint is production-ready.
      const updated = await dependencies.actionService.updateAppointmentStatus(
        writeToken,
        appointmentId,
        observedStatus,
        targetsByAction[action],
      );
      if (!updated) {
        const concurrentEvent =
          await dependencies.actionService.findEventByIdempotencyKey(
            writeToken,
            idempotencyKey,
          );
        if (concurrentEvent !== null) {
          return resultFromEvent(concurrentEvent, requestFingerprint);
        }
        throw new CrcAppointmentActionError("CRC_APPOINTMENT_CONFLICT");
      }

      let event: DirectusCrcAppointmentEventCreateResult;
      try {
        event = await dependencies.actionService.createEvent(
          writeToken,
          eventInputFromAction(
            appointmentId,
            actorUserId,
            action,
            body,
            observedStatus,
            idempotencyKey,
            requestFingerprint,
          ),
        );
      } catch (error: unknown) {
        if (
          error instanceof DirectusError &&
          error.code === "DIRECTUS_CONFLICT"
        ) {
          try {
            const concurrentEvent =
              await dependencies.actionService.findEventByIdempotencyKey(
                writeToken,
                idempotencyKey,
              );
            if (concurrentEvent !== null) {
              return resultFromEvent(concurrentEvent, requestFingerprint);
            }
          } catch (lookupError: unknown) {
            if (lookupError instanceof CrcAppointmentActionError) {
              throw lookupError;
            }
          }
        }
        throw new CrcAppointmentActionError("CRC_HISTORY_WRITE_FAILED");
      }
      return buildActionResult({
        appointmentId,
        action,
        statusFrom: observedStatus,
        statusTo: targetsByAction[action],
        ...(event.eventId === undefined
          ? {}
          : { eventId: event.eventId }),
      });
    })();

    inFlight.set(inFlightKey, { requestFingerprint, promise: operation });
    try {
      return await operation;
    } finally {
      if (inFlight.get(inFlightKey)?.promise === operation) {
        inFlight.delete(inFlightKey);
      }
    }
  };
};

export const executeCrcAppointmentActionUseCase =
  createExecuteCrcAppointmentActionUseCase({
    actionService: crcAppointmentActionsService,
    getWriteToken: () => env.DIRECTUS_CRC_WRITE_TOKEN,
  });
