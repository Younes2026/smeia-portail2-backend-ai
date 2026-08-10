import { z } from "zod";

import {
  ALLOWED_SERVICE_TYPE_IDS,
  ALLOWED_WORKSHOP_IDS,
} from "../ai-diagnostic/index.js";
import {
  BOOKING_PERIODS,
  BOOKING_TIME_ZONE,
  MAX_BOOKING_OPTIONS,
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
    workshop_ids: z
      .array(z.literal(ALLOWED_WORKSHOP_IDS))
      .min(1)
      .max(2)
      .refine(
        (ids) => new Set(ids).size === ids.length,
        "Workshop IDs must be unique.",
      ),
    preferred_date: IsoDateSchema.nullable().optional().default(null),
    preferred_period: z.enum(BOOKING_PERIODS).optional().default("any"),
  })
  .strict();

export const createAppointmentAvailabilityRequestSchema = (
  minimumDate: string,
) =>
  availabilityRequestBaseSchema.superRefine((request, context) => {
    if (
      request.preferred_date !== null &&
      request.preferred_date < minimumDate
    ) {
      context.addIssue({
        code: "custom",
        path: ["preferred_date"],
        message: "The preferred date must not be in the past.",
      });
    }
  });

export type AppointmentAvailabilityRequest = z.infer<
  typeof availabilityRequestBaseSchema
>;

export const BookingShowroomSchema = z
  .object({
    id: z.number().int().positive(),
    name: z.string().trim().min(1),
    address: z.string().trim().min(1).nullable(),
    city: z.string().trim().min(1).nullable(),
    phone: z.string().trim().min(1).nullable(),
  })
  .strict();

export const AppointmentAvailabilityOptionSchema = z
  .object({
    workshop_id: z.literal(ALLOWED_WORKSHOP_IDS),
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
    options: z.array(AppointmentAvailabilityOptionSchema).max(MAX_BOOKING_OPTIONS),
  })
  .strict();

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
    workshop_id: z.literal(ALLOWED_WORKSHOP_IDS),
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
      .max(MAX_BOOKING_OPTIONS),
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
        id: z.literal(ALLOWED_WORKSHOP_IDS),
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
export type AppointmentAvailabilityOption = z.infer<
  typeof AppointmentAvailabilityOptionSchema
>;
export type AppointmentAvailabilityResult = z.infer<
  typeof AppointmentAvailabilityResultSchema
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
