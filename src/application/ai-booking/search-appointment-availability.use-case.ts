import {
  getCompatibleWorkshopIdsForServiceCode,
} from "../../domain/ai-diagnostic/index.js";
import {
  BOOKING_SEARCH_WINDOW_DAYS,
  SecuredAppointmentAvailabilityResultSchema,
  addIsoDateDays,
  createAppointmentAvailabilityRequestSchema,
  findAppointmentAvailability,
  getCasablancaIsoDate,
  getCasablancaIsoTime,
  type DirectusBookingAvailabilitySnapshot,
  type SecuredAppointmentAvailabilityResult,
} from "../../domain/ai-booking/index.js";
import { env } from "../../config/env.js";
import {
  DirectusError,
  getDirectusAiCatalogs,
  getDirectusBookingAvailabilitySnapshot,
  getDirectusVehicleContext,
  type DirectusAiCatalogs,
  type DirectusBookingAvailabilityQuery,
  type DirectusVehicleContext,
} from "../../infrastructure/directus/index.js";
import { BookingAvailabilityError } from "./booking-errors.js";
import {
  createBookingSlotTokenService,
  type BookingSlotTokenService,
} from "./booking-slot-token.service.js";

export type SearchAppointmentAvailabilityUseCaseDependencies = {
  getVehicleContext(
    accessToken: string,
    vehicleId: unknown,
  ): Promise<DirectusVehicleContext>;
  getAiCatalogs(accessToken: string): Promise<DirectusAiCatalogs>;
  getBookingSnapshot(
    query: DirectusBookingAvailabilityQuery,
  ): Promise<DirectusBookingAvailabilitySnapshot>;
  slotTokenService: BookingSlotTokenService;
  now(): Date;
};

export type SearchAppointmentAvailabilityUseCase = (
  accessToken: string,
  request: unknown,
) => Promise<SecuredAppointmentAvailabilityResult>;

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

  return service;
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
    const globalEndDate = addIsoDateDays(
      today,
      BOOKING_SEARCH_WINDOW_DAYS - 1,
    );
    const request = createAppointmentAvailabilityRequestSchema(
      today,
      globalEndDate,
    ).parse(rawRequest);
    dependencies.slotTokenService.assertConfigured();
    await dependencies.getVehicleContext(accessToken, request.vehicle_id);
    const catalogs = await dependencies.getAiCatalogs(accessToken);
    const service = validateRequestedCatalogContext(request, catalogs);

    const startDate = request.preferred_date ?? today;
    const snapshot = await dependencies.getBookingSnapshot({
      workshopIds: [...request.workshop_ids],
      startDate,
      endDate: globalEndDate,
    });
    const result = findAppointmentAvailability(
      request,
      snapshot,
      startDate,
      globalEndDate,
      {
        date: today,
        time: getCasablancaIsoTime(now),
      },
    );

    if (result.options.length === 0) {
      throw new BookingAvailabilityError("BOOKING_AVAILABILITY_NOT_FOUND");
    }

    return SecuredAppointmentAvailabilityResultSchema.parse({
      preferred_date_available: result.preferred_date_available,
      options: result.options.map((option) => {
        const createdToken = dependencies.slotTokenService.create({
          vehicle_id: request.vehicle_id,
          service_type_id: service.id,
          workshop_id: option.workshop_id,
          requested_date: option.requested_date,
          requested_time: option.requested_time,
          slot_interval_minutes: option.slot_interval_minutes,
        });

        return {
          slot_token: createdToken.slotToken,
          expires_at: createdToken.expiresAt,
          service_type: {
            id: service.id,
            name: service.name,
          },
          ...option,
        };
      }),
    });
  };

const systemClock = () => new Date();

export const searchAppointmentAvailabilityUseCase =
  createSearchAppointmentAvailabilityUseCase({
    getVehicleContext: getDirectusVehicleContext,
    getAiCatalogs: getDirectusAiCatalogs,
    getBookingSnapshot: getDirectusBookingAvailabilitySnapshot,
    slotTokenService: createBookingSlotTokenService({
      secret: env.AI_BOOKING_SLOT_SECRET,
      now: systemClock,
    }),
    now: systemClock,
  });
