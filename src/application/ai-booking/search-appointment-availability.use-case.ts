import {
  getCompatibleWorkshopIdsForServiceCode,
} from "../../domain/ai-diagnostic/index.js";
import {
  BOOKING_SEARCH_WINDOW_DAYS,
  addIsoDateDays,
  createAppointmentAvailabilityRequestSchema,
  findAppointmentAvailability,
  getCasablancaIsoDate,
  getCasablancaIsoTime,
  type AppointmentAvailabilityResult,
  type DirectusBookingAvailabilitySnapshot,
} from "../../domain/ai-booking/index.js";
import {
  DirectusError,
  getDirectusAiCatalogs,
  getDirectusBookingAvailabilitySnapshot,
  type DirectusAiCatalogs,
  type DirectusBookingAvailabilityQuery,
} from "../../infrastructure/directus/index.js";
import { BookingAvailabilityError } from "./booking-errors.js";

export type SearchAppointmentAvailabilityUseCaseDependencies = {
  getAiCatalogs(accessToken: string): Promise<DirectusAiCatalogs>;
  getBookingSnapshot(
    query: DirectusBookingAvailabilityQuery,
  ): Promise<DirectusBookingAvailabilitySnapshot>;
  now(): Date;
};

export type SearchAppointmentAvailabilityUseCase = (
  accessToken: string,
  request: unknown,
) => Promise<AppointmentAvailabilityResult>;

const validateRequestedCatalogContext = (
  request: {
    service_type_id: number;
    workshop_ids: readonly (1 | 2 | 3 | 4)[];
  },
  catalogs: DirectusAiCatalogs,
) => {
  const service = catalogs.available_services.find(
    (candidate) => candidate.id === request.service_type_id,
  );
  const availableWorkshopIds = new Set(
    catalogs.available_workshops.map((workshop) => workshop.id),
  );
  const compatibleWorkshopIds =
    service === undefined
      ? null
      : getCompatibleWorkshopIdsForServiceCode(service.code);

  if (
    service === undefined ||
    compatibleWorkshopIds === null ||
    request.workshop_ids.some(
      (workshopId) =>
        !availableWorkshopIds.has(workshopId) ||
        !compatibleWorkshopIds.has(workshopId),
    )
  ) {
    throw new BookingAvailabilityError("BOOKING_AVAILABILITY_NOT_FOUND");
  }
};

export const createSearchAppointmentAvailabilityUseCase = (
  dependencies: SearchAppointmentAvailabilityUseCaseDependencies,
): SearchAppointmentAvailabilityUseCase =>
  async (accessToken, rawRequest) => {
    if (accessToken.trim().length === 0) {
      throw new DirectusError("DIRECTUS_UNAUTHORIZED");
    }

    const now = dependencies.now();
    const today = getCasablancaIsoDate(now);
    const request = createAppointmentAvailabilityRequestSchema(today).parse(
      rawRequest,
    );
    const catalogs = await dependencies.getAiCatalogs(accessToken);
    validateRequestedCatalogContext(request, catalogs);

    const startDate = request.preferred_date ?? today;
    const endDate = addIsoDateDays(
      startDate,
      BOOKING_SEARCH_WINDOW_DAYS - 1,
    );
    const snapshot = await dependencies.getBookingSnapshot({
      workshopIds: [...request.workshop_ids],
      startDate,
      endDate,
    });
    const result = findAppointmentAvailability(request, snapshot, startDate, {
      date: today,
      time: getCasablancaIsoTime(now),
    });

    if (result.options.length === 0) {
      throw new BookingAvailabilityError("BOOKING_AVAILABILITY_NOT_FOUND");
    }

    return result;
  };

export const searchAppointmentAvailabilityUseCase =
  createSearchAppointmentAvailabilityUseCase({
    getAiCatalogs: getDirectusAiCatalogs,
    getBookingSnapshot: getDirectusBookingAvailabilitySnapshot,
    now: () => new Date(),
  });
