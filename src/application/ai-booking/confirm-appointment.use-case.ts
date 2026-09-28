import { env } from "../../config/env.js";
import {
  AppointmentConfirmationRequestSchema,
  AppointmentConfirmationResultSchema,
  BookingIdempotencyKeySchema,
  checkBookingSlotAvailability,
  getCasablancaIsoDate,
  getCasablancaIsoTime,
  type AppointmentConfirmationResult,
  type DirectusBookingAvailabilitySnapshot,
} from "../../domain/ai-booking/index.js";
import { getCompatibleWorkshopTypesForServiceCode } from "../../domain/ai-diagnostic/index.js";
import {
  DirectusError,
  createDirectusAppointment,
  getDirectusAvailableService,
  getDirectusBookingAvailabilitySnapshot,
  getDirectusBookingVehicleIdentity,
  type AvailableService,
  type DirectusAppointmentCreateInput,
  type DirectusBookingAvailabilityQuery,
  type DirectusBookingVehicleIdentity,
  type DirectusCreatedAppointment,
} from "../../infrastructure/directus/index.js";
import { BookingAvailabilityError } from "./booking-errors.js";
import { BookingConfirmationError } from "./booking-confirmation-errors.js";
import {
  createBookingIdempotencyStore,
  type BookingIdempotencyStore,
} from "./booking-idempotency.store.js";
import {
  createBookingSlotLock,
  createBookingSlotLockKey,
  type BookingSlotLock,
} from "./booking-slot-lock.js";
import {
  createBookingSlotTokenService,
  type BookingSlotTokenPayload,
  type BookingSlotTokenService,
} from "./booking-slot-token.service.js";

export const BOOKING_IDEMPOTENCY_TTL_MS = 15 * 60 * 1_000;
export const BOOKING_IDEMPOTENCY_MAX_ENTRIES = 1_000;
export const BOOKING_SLOT_LOCK_IDLE_TTL_MS = 60 * 1_000;
export const BOOKING_SLOT_LOCK_MAX_KEYS = 1_000;

export type ConfirmAppointmentUseCaseDependencies = {
  slotTokenService: BookingSlotTokenService;
  idempotencyStore: BookingIdempotencyStore;
  slotLock: BookingSlotLock;
  getBookingVehicleIdentity(
    accessToken: string,
    vehicleId: unknown,
  ): Promise<DirectusBookingVehicleIdentity>;
  getAvailableService(
    accessToken: string,
    serviceId: unknown,
  ): Promise<AvailableService>;
  getBookingSnapshot(
    query: DirectusBookingAvailabilityQuery,
  ): Promise<DirectusBookingAvailabilitySnapshot>;
  createAppointment(
    accessToken: string,
    input: DirectusAppointmentCreateInput,
  ): Promise<DirectusCreatedAppointment>;
  now(): Date;
};

export type ConfirmAppointmentUseCase = (
  accessToken: string,
  idempotencyKey: unknown,
  request: unknown,
) => Promise<AppointmentConfirmationResult>;

const verifySlotToken = (
  slotTokenService: BookingSlotTokenService,
  slotToken: string,
): BookingSlotTokenPayload => {
  try {
    return slotTokenService.verify(slotToken);
  } catch (error: unknown) {
    if (error instanceof BookingAvailabilityError) {
      if (error.code === "BOOKING_SLOT_TOKEN_INVALID") {
        throw new BookingConfirmationError("INVALID_SLOT_TOKEN");
      }
      if (error.code === "BOOKING_SLOT_TOKEN_EXPIRED") {
        throw new BookingConfirmationError("SLOT_OFFER_EXPIRED");
      }
      if (error.code === "BOOKING_CONFIGURATION_ERROR") {
        throw new BookingConfirmationError(
          "BOOKING_CONFIGURATION_UNAVAILABLE",
        );
      }
    }
    throw error;
  }
};

const validateBookingContext = (
  token: BookingSlotTokenPayload,
  service: AvailableService,
  snapshot: DirectusBookingAvailabilitySnapshot,
) => {
  const workshop = snapshot.workshops.find(
    (candidate) => candidate.id === token.workshop_id,
  );
  const compatibleWorkshopTypes = getCompatibleWorkshopTypesForServiceCode(
    service.code,
  );
  if (
    service.id !== token.service_type_id ||
    workshop === undefined ||
    workshop.showroom.id !== token.showroom_id ||
    compatibleWorkshopTypes === null ||
    !compatibleWorkshopTypes.has(workshop.workshop_type)
  ) {
    throw new BookingConfirmationError("BOOKING_CONTEXT_INVALID");
  }
  return service;
};

const createAppointmentSafely = async (
  dependencies: ConfirmAppointmentUseCaseDependencies,
  accessToken: string,
  input: DirectusAppointmentCreateInput,
) => {
  try {
    return await dependencies.createAppointment(accessToken, input);
  } catch (error: unknown) {
    if (
      error instanceof DirectusError &&
      (error.code === "DIRECTUS_UNAUTHORIZED" ||
        error.code === "DIRECTUS_TIMEOUT")
    ) {
      throw error;
    }
    throw new BookingConfirmationError("APPOINTMENT_CREATION_FAILED");
  }
};

export const createConfirmAppointmentUseCase = (
  dependencies: ConfirmAppointmentUseCaseDependencies,
): ConfirmAppointmentUseCase =>
  async (accessToken, rawIdempotencyKey, rawRequest) => {
    if (accessToken.trim().length === 0) {
      throw new DirectusError("DIRECTUS_UNAUTHORIZED");
    }
    const idempotencyKey = BookingIdempotencyKeySchema.parse(
      rawIdempotencyKey,
    );
    const request = AppointmentConfirmationRequestSchema.parse(rawRequest);

    return dependencies.idempotencyStore.execute(
      accessToken,
      idempotencyKey,
      request,
      async () => {
        const token = verifySlotToken(
          dependencies.slotTokenService,
          request.slot_token,
        );
        const vehicle = await dependencies.getBookingVehicleIdentity(
          accessToken,
          token.vehicle_id,
        );
        if (vehicle.vehicleId !== token.vehicle_id) {
          throw new DirectusError("DIRECTUS_VEHICLE_NOT_ACCESSIBLE");
        }

        const lockKey = createBookingSlotLockKey(token);
        return dependencies.slotLock.withLock(lockKey, async () => {
          let service: AvailableService;
          try {
            service = await dependencies.getAvailableService(
              accessToken,
              token.service_type_id,
            );
          } catch (error: unknown) {
            if (
              error instanceof DirectusError &&
              error.code === "DIRECTUS_NOT_FOUND"
            ) {
              throw new BookingConfirmationError("BOOKING_CONTEXT_INVALID");
            }
            throw error;
          }
          let snapshot: DirectusBookingAvailabilitySnapshot;
          try {
            snapshot = await dependencies.getBookingSnapshot({
              workshopIds: [token.workshop_id],
              showroomId: token.showroom_id,
              startDate: token.requested_date,
              endDate: token.requested_date,
            });
          } catch (error: unknown) {
            if (
              error instanceof DirectusError &&
              (error.code === "DIRECTUS_NOT_FOUND" ||
                error.code === "DIRECTUS_INVALID_RESPONSE")
            ) {
              throw new BookingConfirmationError("BOOKING_CONTEXT_INVALID");
            }
            throw error;
          }
          validateBookingContext(token, service, snapshot);
          const now = dependencies.now();
          const slotCheck = checkBookingSlotAvailability(token, snapshot, {
            date: getCasablancaIsoDate(now),
            time: getCasablancaIsoTime(now),
          });
          if (slotCheck.status === "invalid_context") {
            throw new BookingConfirmationError("BOOKING_CONTEXT_INVALID");
          }
          if (slotCheck.status === "unavailable") {
            throw new BookingConfirmationError("SLOT_NO_LONGER_AVAILABLE");
          }

          const created = await createAppointmentSafely(
            dependencies,
            accessToken,
            {
              customer_id: vehicle.customerId,
              vehicle_id: token.vehicle_id,
              service_type_id: token.service_type_id,
              workshop_id: token.workshop_id,
              requested_date: token.requested_date,
              requested_time: token.requested_time,
              comment: request.problem_summary,
            },
          );
          return AppointmentConfirmationResultSchema.parse({
            appointment_id: created.appointmentId,
            status: created.status,
            vehicle: {
              id: vehicle.vehicleId,
              label: vehicle.label,
            },
            service_type: {
              id: service.id,
              name: service.name,
            },
            workshop: {
              id: slotCheck.workshop.id,
              name: slotCheck.workshop.name,
            },
            showroom: slotCheck.workshop.showroom,
            requested_date: token.requested_date,
            requested_time: token.requested_time,
            problem_summary: request.problem_summary,
          });
        });
      },
    );
  };

const systemClock = () => new Date();

/**
 * Process-local lock shared by client and CRC confirmations.
 * Multi-instance deployments still require a shared transactional lock.
 */
export const sharedBookingSlotLock = createBookingSlotLock({
  now: systemClock,
  idleTtlMs: BOOKING_SLOT_LOCK_IDLE_TTL_MS,
  maxKeys: BOOKING_SLOT_LOCK_MAX_KEYS,
});

export const confirmAppointmentUseCase = createConfirmAppointmentUseCase({
  slotTokenService: createBookingSlotTokenService({
    secret: env.AI_BOOKING_SLOT_SECRET,
    now: systemClock,
  }),
  idempotencyStore: createBookingIdempotencyStore({
    now: systemClock,
    ttlMs: BOOKING_IDEMPOTENCY_TTL_MS,
    maxEntries: BOOKING_IDEMPOTENCY_MAX_ENTRIES,
  }),
  slotLock: sharedBookingSlotLock,
  getBookingVehicleIdentity: getDirectusBookingVehicleIdentity,
  getAvailableService: getDirectusAvailableService,
  getBookingSnapshot: getDirectusBookingAvailabilitySnapshot,
  createAppointment: createDirectusAppointment,
  now: systemClock,
});
