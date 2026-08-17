import { env } from "../../config/env.js";
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
  createDirectusCatalogService,
  type AvailableService,
  type AvailableWorkshop,
  type DirectusAiCatalogs,
  type DirectusCatalogService,
} from "./directus-catalog.service.js";
export {
  DirectusError,
  mapDirectusHttpStatus,
  type DirectusErrorCode,
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
