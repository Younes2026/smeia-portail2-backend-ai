import {
  getCompatibleWorkshopTypesForServiceCode,
} from "../../domain/ai-diagnostic/index.js";
import {
  BOOKING_SEARCH_WINDOW_DAYS,
  AppointmentAvailabilityCalendarResultSchema,
  SecuredAppointmentAvailabilityResultSchema,
  addIsoDateDays,
  createAppointmentAvailabilityRequestSchema,
  findAppointmentAvailability,
  findAppointmentAvailabilityCalendar,
  getCasablancaIsoDate,
  getCasablancaIsoTime,
  type AppointmentAvailabilityCalendarResult,
  type BookingWorkshopType,
  type DirectusBookingAvailabilitySnapshot,
  type SecuredAppointmentAvailabilityResult,
} from "../../domain/ai-booking/index.js";
import { env } from "../../config/env.js";
import {
  DirectusError,
  getDirectusAvailableService,
  getDirectusBookingAvailabilitySnapshot,
  getDirectusVehicleContext,
  resolveDirectusBookingWorkshops,
  type AvailableService,
  type DirectusBookingAvailabilityQuery,
  type DirectusWorkshopResolutionQuery,
  type DirectusVehicleContext,
  type ResolvedBookingWorkshop,
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
  getAvailableService(
    accessToken: string,
    serviceId: unknown,
  ): Promise<AvailableService>;
  resolveBookingWorkshops(
    query: DirectusWorkshopResolutionQuery,
  ): Promise<ResolvedBookingWorkshop[]>;
  getBookingSnapshot(
    query: DirectusBookingAvailabilityQuery,
  ): Promise<DirectusBookingAvailabilitySnapshot>;
  slotTokenService: BookingSlotTokenService;
  now(): Date;
};

export type SearchAppointmentAvailabilityUseCase = (
  accessToken: string,
  request: unknown,
) => Promise<
  SecuredAppointmentAvailabilityResult | AppointmentAvailabilityCalendarResult
>;

const validateRequestedServiceContext = (
  request: {
    workshop_types: readonly BookingWorkshopType[];
  },
  service: AvailableService,
) => {
  const compatibleWorkshopTypes = getCompatibleWorkshopTypesForServiceCode(
    service.code,
  );

  if (
    compatibleWorkshopTypes === null ||
    request.workshop_types.some(
      (workshopType) => !compatibleWorkshopTypes.has(workshopType),
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
    const globalEndDate = addIsoDateDays(
      today,
      BOOKING_SEARCH_WINDOW_DAYS - 1,
    );
    const request = createAppointmentAvailabilityRequestSchema(
      today,
      globalEndDate,
    ).parse(rawRequest);
    if (request.result_mode !== "calendar") {
      dependencies.slotTokenService.assertConfigured();
    }
    await dependencies.getVehicleContext(accessToken, request.vehicle_id);
    let service: AvailableService;
    try {
      service = await dependencies.getAvailableService(
        accessToken,
        request.service_type_id,
      );
    } catch (error: unknown) {
      if (
        error instanceof DirectusError &&
        error.code === "DIRECTUS_NOT_FOUND"
      ) {
        throw new BookingAvailabilityError("BOOKING_AVAILABILITY_NOT_FOUND");
      }
      throw error;
    }
    validateRequestedServiceContext(request, service);

    let resolvedWorkshops: ResolvedBookingWorkshop[];
    try {
      resolvedWorkshops = await dependencies.resolveBookingWorkshops({
        showroomId: request.showroom_id,
        workshopTypes: [...request.workshop_types],
      });
    } catch (error: unknown) {
      if (
        error instanceof DirectusError &&
        error.code === "DIRECTUS_NOT_FOUND"
      ) {
        throw new BookingAvailabilityError("BOOKING_AVAILABILITY_NOT_FOUND");
      }
      throw error;
    }

    const startDate =
      request.result_mode === "calendar"
        ? today
        : request.preferred_date ?? today;
    const endDate =
      request.result_mode === "day_slots" ? startDate : globalEndDate;
    const snapshot = await dependencies.getBookingSnapshot({
      workshopIds: resolvedWorkshops.map((workshop) => workshop.id),
      showroomId: request.showroom_id,
      startDate,
      endDate,
    });

    if (request.result_mode === "calendar") {
      return AppointmentAvailabilityCalendarResultSchema.parse(
        findAppointmentAvailabilityCalendar(
          request,
          snapshot,
          startDate,
          endDate,
          {
            date: today,
            time: getCasablancaIsoTime(now),
          },
        ),
      );
    }

    const result = findAppointmentAvailability(
      request,
      snapshot,
      startDate,
      endDate,
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
          showroom_id: option.showroom.id,
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
    getAvailableService: getDirectusAvailableService,
    resolveBookingWorkshops: resolveDirectusBookingWorkshops,
    getBookingSnapshot: getDirectusBookingAvailabilitySnapshot,
    slotTokenService: createBookingSlotTokenService({
      secret: env.AI_BOOKING_SLOT_SECRET,
      now: systemClock,
    }),
    now: systemClock,
  });
