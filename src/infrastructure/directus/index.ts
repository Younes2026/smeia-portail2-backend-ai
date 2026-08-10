import { env } from "../../config/env.js";
import {
  createDirectusBookingAvailabilityService,
  type DirectusBookingAvailabilityQuery,
} from "./directus-booking-availability.service.js";
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

const configuredBookingAvailabilityService =
  createDirectusBookingAvailabilityService(
    createDirectusHttpClient({
      baseUrl: env.DIRECTUS_URL,
      timeoutMs: env.DIRECTUS_TIMEOUT_MS,
    }),
  );

export const getDirectusAiCatalogs = (accessToken: string) =>
  configuredCatalogService.getAiCatalogs(accessToken);

export const getDirectusVehicleContext = (
  accessToken: string,
  vehicleId: unknown,
) => configuredVehicleContextService.getVehicleContext(accessToken, vehicleId);

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

export {
  createDirectusBookingAvailabilityService,
  type DirectusBookingAvailabilityQuery,
  type DirectusBookingAvailabilityService,
} from "./directus-booking-availability.service.js";

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
