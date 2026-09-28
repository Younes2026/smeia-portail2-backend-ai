import { env } from "../../config/env.js";
import type { CrcAppointmentListQuery as DirectusCrcAppointmentsListQuery } from "../../domain/crc-appointments/index.js";
import {
  createDirectusBookingAvailabilityService,
  type DirectusBookingAvailabilityQuery,
  type DirectusWorkshopResolutionQuery,
} from "./directus-booking-availability.service.js";
import {
  createDirectusAppointmentWriteClient,
  type DirectusAppointmentCreateInput,
} from "./directus-appointment-write-client.js";
import { createDirectusBookingVehicleService } from "./directus-booking-vehicle.service.js";
import { createDirectusCatalogService } from "./directus-catalog.service.js";
import { createDirectusCrcAppointmentsService } from "./directus-crc-appointments.service.js";
import { createDirectusCrcAppointmentActionsService } from "./directus-crc-appointment-actions.service.js";
import { createDirectusCurrentUserService } from "./directus-current-user.service.js";
import { DirectusError } from "./directus-errors.js";
import { createDirectusHttpClient } from "./directus-http-client.js";
import { createDirectusVehicleContextService } from "./directus-vehicle-context.service.js";

const configuredCatalogService = createDirectusCatalogService(
  createDirectusHttpClient({
    baseUrl: env.DIRECTUS_URL,
    timeoutMs: env.DIRECTUS_TIMEOUT_MS,
  }),
);

const configuredVehicleContextService = createDirectusVehicleContextService(
  createDirectusHttpClient({
    baseUrl: env.DIRECTUS_URL,
    timeoutMs: env.DIRECTUS_TIMEOUT_MS,
  }),
);

const configuredBookingVehicleService = createDirectusBookingVehicleService(
  createDirectusHttpClient({
    baseUrl: env.DIRECTUS_URL,
    timeoutMs: env.DIRECTUS_TIMEOUT_MS,
  }),
);

const configuredAppointmentWriteClient =
  createDirectusAppointmentWriteClient({
    baseUrl: env.DIRECTUS_URL,
    timeoutMs: env.DIRECTUS_TIMEOUT_MS,
  });

const configuredBookingAvailabilityService =
  createDirectusBookingAvailabilityService(
    createDirectusHttpClient({
      baseUrl: env.DIRECTUS_URL,
      timeoutMs: env.DIRECTUS_TIMEOUT_MS,
    }),
  );

const configuredCurrentUserService = createDirectusCurrentUserService({
  baseUrl: env.DIRECTUS_URL,
  timeoutMs: env.DIRECTUS_TIMEOUT_MS,
});

const configuredCrcAppointmentsService =
  createDirectusCrcAppointmentsService(
    createDirectusHttpClient({
      baseUrl: env.DIRECTUS_URL,
      timeoutMs: env.DIRECTUS_TIMEOUT_MS,
    }),
  );

export const crcAppointmentActionsService =
  createDirectusCrcAppointmentActionsService({
    baseUrl: env.DIRECTUS_URL,
    timeoutMs: env.DIRECTUS_TIMEOUT_MS,
  });

export const getDirectusAiCatalogs = (accessToken: string) =>
  configuredCatalogService.getAiCatalogs(accessToken);

export const getDirectusAvailableService = (
  accessToken: string,
  serviceId: unknown,
) => configuredCatalogService.getAvailableService(accessToken, serviceId);

export const getDirectusVehicleContext = (
  accessToken: string,
  vehicleId: unknown,
) => configuredVehicleContextService.getVehicleContext(accessToken, vehicleId);

export const getDirectusBookingVehicleIdentity = (
  accessToken: string,
  vehicleId: unknown,
) =>
  configuredBookingVehicleService.getBookingVehicleIdentity(
    accessToken,
    vehicleId,
  );

export const createDirectusAppointment = (
  accessToken: string,
  input: DirectusAppointmentCreateInput,
) => configuredAppointmentWriteClient.createAppointment(accessToken, input);

export const getDirectusCurrentUser = (accessToken: string) =>
  configuredCurrentUserService.getCurrentUser(accessToken);

export const listDirectusCrcAppointments = (
  accessToken: string,
  query: DirectusCrcAppointmentsListQuery,
) => configuredCrcAppointmentsService.listAppointments(accessToken, query);

export const getDirectusCrcAppointment = (
  accessToken: string,
  appointmentId: number,
) =>
  configuredCrcAppointmentsService.getAppointment(
    accessToken,
    appointmentId,
  );

export const getDirectusBookingAvailabilitySnapshot = async (
  query: DirectusBookingAvailabilityQuery,
) => {
  const bookingToken = env.DIRECTUS_BOOKING_TOKEN;
  if (bookingToken === undefined) {
    throw new DirectusError("DIRECTUS_ERROR");
  }

  try {
    return await configuredBookingAvailabilityService.getBookingAvailabilitySnapshot(
      bookingToken,
      query,
    );
  } catch (error: unknown) {
    if (
      error instanceof DirectusError &&
      (error.code === "DIRECTUS_UNAUTHORIZED" ||
        error.code === "DIRECTUS_FORBIDDEN")
    ) {
      throw new DirectusError("DIRECTUS_ERROR");
    }

    throw error;
  }
};

/**
 * Reuses the configured availability reader with an explicitly supplied
 * backend credential. CRC actions pass their dedicated writer token here so
 * the human Agent CRC token never acquires technical permissions.
 */
export const getDirectusBookingAvailabilitySnapshotWithToken = (
  technicalToken: string,
  query: DirectusBookingAvailabilityQuery,
) =>
  configuredBookingAvailabilityService.getBookingAvailabilitySnapshot(
    technicalToken,
    query,
  );

export const resolveDirectusBookingWorkshops = async (
  query: DirectusWorkshopResolutionQuery,
) => {
  const bookingToken = env.DIRECTUS_BOOKING_TOKEN;
  if (bookingToken === undefined) {
    throw new DirectusError("DIRECTUS_ERROR");
  }

  try {
    return await configuredBookingAvailabilityService.resolveBookingWorkshops(
      bookingToken,
      query,
    );
  } catch (error: unknown) {
    if (
      error instanceof DirectusError &&
      (error.code === "DIRECTUS_UNAUTHORIZED" ||
        error.code === "DIRECTUS_FORBIDDEN")
    ) {
      throw new DirectusError("DIRECTUS_ERROR");
    }

    throw error;
  }
};

export {
  DirectusAppointmentCreateInputSchema,
  createDirectusAppointmentWriteClient,
  type DirectusAppointmentCreateInput,
  type DirectusAppointmentWriteClient,
  type DirectusAppointmentWriteClientConfig,
  type DirectusCreatedAppointment,
} from "./directus-appointment-write-client.js";
export {
  DirectusWorkshopResolutionQuerySchema,
  createDirectusBookingAvailabilityService,
  type DirectusBookingAvailabilityQuery,
  type DirectusBookingAvailabilityService,
  type DirectusWorkshopResolutionQuery,
  type ResolvedBookingWorkshop,
} from "./directus-booking-availability.service.js";
export {
  createDirectusBookingVehicleService,
  type DirectusBookingVehicleIdentity,
  type DirectusBookingVehicleService,
} from "./directus-booking-vehicle.service.js";
export {
  CRC_EVENT_TYPES,
  CrcDirectusActionStepError,
  createDirectusCrcAppointmentActionsService,
  type CrcDirectusActionStep,
  type CrcEventType,
  type DirectusCrcAppointmentActionsService,
  type DirectusCrcAppointmentActionsServiceConfig,
  type DirectusCrcAppointmentActionContext,
  type DirectusCrcAppointmentObservedState,
  type DirectusCrcAppointmentEventCreateInput,
  type DirectusCrcAppointmentEventCreateResult,
  type DirectusCrcAppointmentReplayEvent,
  type DirectusCrcAppointmentSlotUpdate,
} from "./directus-crc-appointment-actions.service.js";
export {
  createDirectusCrcAppointmentsService,
  type DirectusCrcAppointmentsService,
} from "./directus-crc-appointments.service.js";
export {
  createDirectusCurrentUserService,
  type DirectusCurrentUser,
  type DirectusCurrentUserService,
  type DirectusCurrentUserServiceConfig,
} from "./directus-current-user.service.js";

export {
  createDirectusCatalogService,
  type AvailableService,
  type AvailableWorkshop,
  type DirectusAiCatalogs,
  type DirectusCatalogService,
} from "./directus-catalog.service.js";
export {
  describeDirectusJsonResponse,
  DirectusError,
  mapDirectusHttpStatus,
  type DirectusErrorCode,
  type DirectusResponseDiagnostic,
} from "./directus-errors.js";
export {
  createDirectusHttpClient,
  type DirectusFetch,
  type DirectusHttpClientConfig,
  type DirectusReadClient,
} from "./directus-http-client.js";
export {
  createDirectusVehicleContextService,
  type DirectusVehicleContext,
  type DirectusVehicleContextService,
} from "./directus-vehicle-context.service.js";
