import { z } from "zod";

import {
  ALLOWED_SERVICE_TYPE_IDS,
  ALLOWED_WORKSHOP_TYPES,
} from "../ai-diagnostic/index.js";
import {
  BOOKING_PERIODS,
  BOOKING_RESULT_MODES,
  BOOKING_SEARCH_WINDOW_DAYS,
  BOOKING_TIME_ZONE,
  MAX_DAY_SLOT_OPTIONS,
} from "./ai-booking.constants.js";

const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/;
const isoTimePattern = /^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/;
const isoDateTimePattern =
  /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/;

export const BookingVehicleIdSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);

export const BookingPhysicalWorkshopIdSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);

export const BookingShowroomIdSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);

export const BookingWorkshopTypeSchema = z.enum(ALLOWED_WORKSHOP_TYPES);

export const isValidIsoDate = (value: string) => {
  if (!isoDatePattern.test(value)) {
    return false;
  }

  const [year, month, day] = value.split("-").map(Number);
  if (year === undefined || month === undefined || day === undefined) {
    return false;
  }

  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
};

export const IsoDateSchema = z
  .string()
  .regex(isoDatePattern)
  .refine(isValidIsoDate, "The date must be a valid ISO calendar date.");

export const IsoTimeSchema = z.string().regex(isoTimePattern);

export const IsoDateTimeSchema = z
  .string()
  .regex(isoDateTimePattern)
  .refine((value) => !Number.isNaN(Date.parse(value)));

const availabilityRequestBaseSchema = z
  .object({
    vehicle_id: BookingVehicleIdSchema,
    service_type_id: z.literal(ALLOWED_SERVICE_TYPE_IDS),
    showroom_id: BookingShowroomIdSchema,
    workshop_types: z
      .array(BookingWorkshopTypeSchema)
      .min(1)
      .max(2)
      .refine(
        (types) => new Set(types).size === types.length,
        "Workshop types must be unique.",
      ),
    preferred_date: IsoDateSchema.nullable().optional().default(null),
    preferred_period: z.enum(BOOKING_PERIODS).optional().default("any"),
    result_mode: z.enum(BOOKING_RESULT_MODES).optional().default("suggestions"),
  })
  .strict();

export const createAppointmentAvailabilityRequestSchema = (
  minimumDate: string,
  maximumDate: string,
) =>
  availabilityRequestBaseSchema.superRefine((request, context) => {
    if (
      request.result_mode === "day_slots" &&
      request.preferred_date === null
    ) {
      context.addIssue({
        code: "custom",
        path: ["preferred_date"],
        message: "A preferred date is required in day-slots mode.",
      });
      return;
    }

    if (
      request.result_mode === "calendar" &&
      (request.preferred_date !== null || request.preferred_period !== "any")
    ) {
      context.addIssue({
        code: "custom",
        path: [
          request.preferred_date !== null
            ? "preferred_date"
            : "preferred_period",
        ],
        message:
          "Calendar mode covers the complete booking horizon and all periods.",
      });
      return;
    }

    if (request.preferred_date === null) {
      return;
    }

    if (request.preferred_date < minimumDate) {
      context.addIssue({
        code: "custom",
        path: ["preferred_date"],
        message: "The preferred date must not be in the past.",
      });
    }

    if (request.preferred_date > maximumDate) {
      context.addIssue({
        code: "custom",
        path: ["preferred_date"],
        message: "The preferred date exceeds the booking search window.",
      });
    }
  });

export type AppointmentAvailabilityRequest = z.infer<
  typeof availabilityRequestBaseSchema
>;

export const BookingShowroomSchema = z
  .object({
    id: BookingShowroomIdSchema,
    name: z.string().trim().min(1),
    address: z.string().trim().min(1).nullable(),
    city: z.string().trim().min(1).nullable(),
    phone: z.string().trim().min(1).nullable(),
  })
  .strict();

export const AppointmentAvailabilityOptionSchema = z
  .object({
    workshop_id: BookingPhysicalWorkshopIdSchema,
    workshop_name: z.string().trim().min(1),
    showroom: BookingShowroomSchema,
    requested_date: IsoDateSchema,
    requested_time: IsoTimeSchema,
    slot_interval_minutes: z.number().int().positive(),
    label: z.string().trim().min(1),
  })
  .strict();

export const AppointmentAvailabilityResultSchema = z
  .object({
    preferred_date_available: z.boolean(),
    options: z
      .array(AppointmentAvailabilityOptionSchema)
      .max(MAX_DAY_SLOT_OPTIONS),
  })
  .strict();

export const AppointmentAvailabilityCalendarDaySchema = z
  .object({
    date: IsoDateSchema,
    available_slot_count: z.number().int().positive(),
    morning_slot_count: z.number().int().nonnegative(),
    afternoon_slot_count: z.number().int().nonnegative(),
  })
  .strict()
  .refine(
    (day) =>
      day.available_slot_count ===
      day.morning_slot_count + day.afternoon_slot_count,
    "The period counts must equal the available slot count.",
  );

export const AppointmentAvailabilityCalendarResultSchema = z
  .object({
    result_mode: z.literal("calendar"),
    timezone: z.literal(BOOKING_TIME_ZONE),
    horizon_start: IsoDateSchema,
    horizon_end: IsoDateSchema,
    days: z
      .array(AppointmentAvailabilityCalendarDaySchema)
      .max(BOOKING_SEARCH_WINDOW_DAYS),
  })
  .strict()
  .superRefine((result, context) => {
    const dates = result.days.map((day) => day.date);
    if (
      result.horizon_start > result.horizon_end ||
      dates.some(
        (date, index) =>
          date < result.horizon_start ||
          date > result.horizon_end ||
          (index > 0 && date <= (dates[index - 1] ?? date)),
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["days"],
        message: "Calendar days must be unique, sorted and within the horizon.",
      });
    }
  });

export const BookingServiceTypeSchema = z
  .object({
    id: z.literal(ALLOWED_SERVICE_TYPE_IDS),
    name: z.string().trim().min(1),
  })
  .strict();

export const SecuredAppointmentAvailabilityOptionSchema = z
  .object({
    slot_token: z.string().trim().min(1),
    expires_at: IsoDateTimeSchema,
    service_type: BookingServiceTypeSchema,
    workshop_id: BookingPhysicalWorkshopIdSchema,
    workshop_name: z.string().trim().min(1),
    showroom: BookingShowroomSchema,
    requested_date: IsoDateSchema,
    requested_time: IsoTimeSchema,
    slot_interval_minutes: z.number().int().positive(),
    label: z.string().trim().min(1),
  })
  .strict();

export const SecuredAppointmentAvailabilityResultSchema = z
  .object({
    preferred_date_available: z.boolean(),
    options: z
      .array(SecuredAppointmentAvailabilityOptionSchema)
      .max(MAX_DAY_SLOT_OPTIONS),
  })
  .strict();

export const AppointmentConfirmationRequestSchema = z
  .object({
    slot_token: z.string().trim().min(1).max(4_096),
    problem_summary: z
      .string()
      .trim()
      .min(10)
      .max(1_000)
      .refine((value) => !/[<>]/.test(value), "HTML is not accepted.")
      .refine(
        (value) =>
          !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value),
        "Control characters are not accepted.",
      ),
    confirmation: z.literal(true),
  })
  .strict();

export const BookingIdempotencyKeySchema = z.uuid();

export const AppointmentConfirmationResultSchema = z
  .object({
    appointment_id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    status: z.literal("pending"),
    vehicle: z
      .object({
        id: BookingVehicleIdSchema,
        label: z.string().trim().min(1).max(201),
      })
      .strict(),
    service_type: BookingServiceTypeSchema,
    workshop: z
      .object({
        id: BookingPhysicalWorkshopIdSchema,
        name: z.string().trim().min(1),
      })
      .strict(),
    showroom: BookingShowroomSchema,
    requested_date: IsoDateSchema,
    requested_time: IsoTimeSchema,
    problem_summary: z.string().trim().min(10).max(1_000),
  })
  .strict();

export type BookingShowroom = z.infer<typeof BookingShowroomSchema>;
export type BookingWorkshopType = z.infer<typeof BookingWorkshopTypeSchema>;
export type AppointmentAvailabilityOption = z.infer<
  typeof AppointmentAvailabilityOptionSchema
>;
export type AppointmentAvailabilityResult = z.infer<
  typeof AppointmentAvailabilityResultSchema
>;
export type AppointmentAvailabilityCalendarDay = z.infer<
  typeof AppointmentAvailabilityCalendarDaySchema
>;
export type AppointmentAvailabilityCalendarResult = z.infer<
  typeof AppointmentAvailabilityCalendarResultSchema
>;
export type BookingServiceType = z.infer<typeof BookingServiceTypeSchema>;
export type SecuredAppointmentAvailabilityOption = z.infer<
  typeof SecuredAppointmentAvailabilityOptionSchema
>;
export type SecuredAppointmentAvailabilityResult = z.infer<
  typeof SecuredAppointmentAvailabilityResultSchema
>;
export type AppointmentConfirmationRequest = z.infer<
  typeof AppointmentConfirmationRequestSchema
>;
export type AppointmentConfirmationResult = z.infer<
  typeof AppointmentConfirmationResultSchema
>;

export const BookingTimeZoneSchema = z.literal(BOOKING_TIME_ZONE);
