import { createHash } from "node:crypto";

import {
  BookingAvailabilityError,
  createBookingSlotLockKey,
  createBookingSlotTokenService,
  sharedBookingSlotLock,
  type BookingSlotLock,
  type BookingSlotTokenPayload,
  type BookingSlotTokenService,
} from "../ai-booking/index.js";
import {
  checkBookingSlotAvailability,
  getCasablancaIsoDate,
  getCasablancaIsoTime,
  type DirectusBookingAvailabilitySnapshot,
} from "../../domain/ai-booking/index.js";
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
  type CrcSelectedSlotConfirmActionBody,
  type CrcAppointmentStatus,
} from "../../domain/crc-appointments/index.js";
import {
  CrcDirectusActionStepError,
  DirectusError,
  crcAppointmentActionsService,
  getDirectusBookingAvailabilitySnapshotWithToken,
  type CrcEventType,
  type DirectusBookingAvailabilityQuery,
  type DirectusCrcAppointmentActionContext,
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
  slotTokenService: BookingSlotTokenService;
  slotLock: BookingSlotLock;
  getBookingSnapshot(
    technicalToken: string,
    query: DirectusBookingAvailabilityQuery,
  ): Promise<DirectusBookingAvailabilitySnapshot>;
  now(): Date;
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

const isSelectedSlotConfirmation = (
  action: CrcAppointmentAction,
  body: ParsedActionBody,
): body is CrcSelectedSlotConfirmActionBody =>
  action === "confirm" && "selection" in body;

const verifySelectedSlotToken = (
  service: BookingSlotTokenService,
  token: string,
): BookingSlotTokenPayload => {
  try {
    return service.verify(token);
  } catch (error: unknown) {
    if (error instanceof BookingAvailabilityError) {
      if (error.code === "BOOKING_SLOT_TOKEN_INVALID") {
        throw new CrcAppointmentActionError("CRC_SLOT_TOKEN_INVALID");
      }
      if (error.code === "BOOKING_SLOT_TOKEN_EXPIRED") {
        throw new CrcAppointmentActionError("CRC_SLOT_TOKEN_EXPIRED");
      }
      if (error.code === "BOOKING_CONFIGURATION_ERROR") {
        throw new CrcAppointmentActionError(
          "CRC_SLOT_VALIDATION_UNAVAILABLE",
        );
      }
    }
    throw error;
  }
};

const validateSelectedSlotContext = (
  slot: BookingSlotTokenPayload,
  appointment: DirectusCrcAppointmentActionContext,
) => {
  if (
    slot.vehicle_id !== appointment.vehicleId ||
    slot.service_type_id !== appointment.serviceTypeId ||
    slot.workshop_id !== appointment.workshopId ||
    slot.showroom_id !== appointment.showroomId
  ) {
    throw new CrcAppointmentActionError("CRC_SLOT_CONTEXT_MISMATCH");
  }
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
  selectedConfirmation?: {
    previousDate: string;
    previousTime: string;
    selectedDate: string;
    selectedTime: string;
    workshopId: number;
  };
}) => {
  const parsed = CrcAppointmentActionResultSchema.safeParse({
    appointment_id: input.appointmentId,
    action: input.action,
    status_from: input.statusFrom,
    status_to: input.statusTo,
    ...(input.eventId === undefined ? {} : { event_id: input.eventId }),
    history_recorded: true,
    ...(input.selectedConfirmation === undefined
      ? {}
      : {
          previous_slot: {
            date: input.selectedConfirmation.previousDate,
            time: input.selectedConfirmation.previousTime,
          },
          selected_slot: {
            date: input.selectedConfirmation.selectedDate,
            time: input.selectedConfirmation.selectedTime,
            workshop_id: input.selectedConfirmation.workshopId,
          },
          agreement_channel: "telephone" as const,
        }),
  });
  if (!parsed.success) {
    throw new DirectusError("DIRECTUS_INVALID_RESPONSE");
  }
  return parsed.data;
};

const resultFromEvent = (
  event: DirectusCrcAppointmentReplayEvent,
  expectedFingerprint: string,
  selectedConfirmation?: {
    previousDate: string;
    previousTime: string;
    selectedDate: string;
    selectedTime: string;
    workshopId: number;
  },
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
    ...(selectedConfirmation === undefined
      ? {}
      : { selectedConfirmation }),
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

export const CRC_ACTION_RESULT_CACHE_MAX_ENTRIES = 1_000;

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
  const completed = new Map<
    string,
    {
      requestFingerprint: string;
      result: CrcAppointmentActionResult;
    }
  >();

  const rememberCompletedResult = (
    key: string,
    requestFingerprint: string,
    result: CrcAppointmentActionResult,
  ) => {
    if (completed.size >= CRC_ACTION_RESULT_CACHE_MAX_ENTRIES) {
      const oldestKey = completed.keys().next().value as string | undefined;
      if (oldestKey !== undefined) {
        completed.delete(oldestKey);
      }
    }
    completed.set(key, { requestFingerprint, result });
  };

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
    const completedRequest = completed.get(inFlightKey);
    if (completedRequest !== undefined) {
      if (completedRequest.requestFingerprint !== requestFingerprint) {
        throw new CrcAppointmentActionError("CRC_IDEMPOTENCY_CONFLICT");
      }
      return completedRequest.result;
    }
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

      const executeTransition = async (
        selectedSlot?: BookingSlotTokenPayload,
      ): Promise<CrcAppointmentActionResult> => {
        const observedAppointment =
          selectedSlot === undefined
            ? undefined
            : await dependencies.actionService.getAppointment(
                writeToken,
                appointmentId,
              );
        const observedStatus =
          selectedSlot === undefined
            ? await dependencies.actionService.getAppointmentStatus(
                writeToken,
                appointmentId,
              )
            : observedAppointment?.status;
        if (observedStatus === undefined || observedStatus === null) {
          throw new CrcAppointmentActionError("CRC_APPOINTMENT_NOT_FOUND");
        }
        if (
          observedStatus !== "pending" &&
          observedStatus !== "callback_pending"
        ) {
          throw new CrcAppointmentActionError(
            "CRC_APPOINTMENT_NOT_TREATABLE",
          );
        }

        const selectedConfirmation =
          selectedSlot === undefined ||
          observedAppointment === undefined ||
          observedAppointment === null
            ? undefined
            : {
                previousDate: observedAppointment.requestedDate,
                previousTime: observedAppointment.requestedTime,
                selectedDate: selectedSlot.requested_date,
                selectedTime: selectedSlot.requested_time,
                workshopId: selectedSlot.workshop_id,
              };

        if (selectedSlot !== undefined) {
          if (
            observedAppointment === undefined ||
            observedAppointment === null
          ) {
            throw new CrcDirectusActionStepError(
              new DirectusError("DIRECTUS_INVALID_RESPONSE"),
              "CRC_APPOINTMENT_READ",
            );
          }
          validateSelectedSlotContext(selectedSlot, observedAppointment);
          let snapshot: DirectusBookingAvailabilitySnapshot;
          try {
            snapshot = await dependencies.getBookingSnapshot(writeToken, {
              workshopIds: [selectedSlot.workshop_id],
              showroomId: selectedSlot.showroom_id,
              startDate: selectedSlot.requested_date,
              endDate: selectedSlot.requested_date,
              excludedAppointmentId: appointmentId,
            });
          } catch (error: unknown) {
            if (error instanceof CrcDirectusActionStepError) {
              throw error;
            }
            if (error instanceof DirectusError) {
              throw new CrcDirectusActionStepError(
                error,
                "CRC_SLOT_REVALIDATE",
              );
            }
            throw new CrcAppointmentActionError(
              "CRC_SLOT_VALIDATION_UNAVAILABLE",
            );
          }
          const now = dependencies.now();
          const availability = checkBookingSlotAvailability(
            selectedSlot,
            snapshot,
            {
              date: getCasablancaIsoDate(now),
              time: getCasablancaIsoTime(now),
            },
          );
          if (availability.status === "invalid_context") {
            throw new CrcAppointmentActionError(
              "CRC_SLOT_CONTEXT_MISMATCH",
            );
          }
          if (availability.status === "unavailable") {
            throw new CrcAppointmentActionError(
              "CRC_SLOT_NO_LONGER_AVAILABLE",
            );
          }
        }

        const updated =
          await dependencies.actionService.updateAppointmentStatus(
            writeToken,
            observedAppointment ?? { id: appointmentId, status: observedStatus },
            targetsByAction[action],
            selectedSlot === undefined
              ? undefined
              : {
                  requestedDate: selectedSlot.requested_date,
                  requestedTime: selectedSlot.requested_time,
                },
          );
        if (!updated) {
          const concurrentEvent =
            await dependencies.actionService.findEventByIdempotencyKey(
              writeToken,
              idempotencyKey,
            );
          if (concurrentEvent !== null) {
            return resultFromEvent(
              concurrentEvent,
              requestFingerprint,
              selectedConfirmation,
            );
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
                return resultFromEvent(
                  concurrentEvent,
                  requestFingerprint,
                  selectedConfirmation,
                );
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
          ...(selectedConfirmation === undefined
            ? {}
            : { selectedConfirmation }),
        });
      };

      if (isSelectedSlotConfirmation(action, body)) {
        const selectedSlot = verifySelectedSlotToken(
          dependencies.slotTokenService,
          body.selection.slot_token,
        );
        return dependencies.slotLock.withLock(
          createBookingSlotLockKey(selectedSlot),
          () => executeTransition(selectedSlot),
        );
      }

      return executeTransition();
    })();

    inFlight.set(inFlightKey, { requestFingerprint, promise: operation });
    try {
      const result = await operation;
      rememberCompletedResult(inFlightKey, requestFingerprint, result);
      return result;
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
    slotTokenService: createBookingSlotTokenService({
      secret: env.AI_BOOKING_SLOT_SECRET,
      now: () => new Date(),
    }),
    slotLock: sharedBookingSlotLock,
    getBookingSnapshot: getDirectusBookingAvailabilitySnapshotWithToken,
    now: () => new Date(),
  });
