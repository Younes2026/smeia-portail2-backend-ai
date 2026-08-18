import { z } from "zod";

import { ALLOWED_WORKSHOP_TYPES } from "../ai-diagnostic/index.js";
import { IsoDateSchema, IsoTimeSchema } from "../ai-booking/index.js";

const positiveSafeIntegerSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);

const parseQueryInteger = (value: unknown) => {
  if (typeof value === "string" && /^\d+$/.test(value)) {
    return Number(value);
  }
  return value;
};

const optionalQueryIntegerSchema = z.preprocess(
  parseQueryInteger,
  positiveSafeIntegerSchema.optional(),
);

const queryLimitSchema = z.preprocess(
  parseQueryInteger,
  z.number().int().min(1).max(100).default(50),
);

const queryOffsetSchema = z.preprocess(
  parseQueryInteger,
  z.number().int().min(0).max(1_000_000).default(0),
);

export const CrcAppointmentIdSchema = positiveSafeIntegerSchema;

export const CrcAppointmentIdParameterSchema = z.preprocess(
  parseQueryInteger,
  CrcAppointmentIdSchema,
);

export const CRC_APPOINTMENT_STATUSES = [
  "pending",
  "callback_pending",
  "alternative_proposed",
  "confirmed",
  "rejected",
  "cancelled",
] as const;

export const CrcAppointmentStatusSchema = z.enum(CRC_APPOINTMENT_STATUSES);

export const CRC_APPOINTMENT_QUEUES = [
  "new",
  "callback",
  "proposed",
  "processed",
] as const;

export const CrcAppointmentQueueSchema = z.enum(CRC_APPOINTMENT_QUEUES);

export const CrcAppointmentListQuerySchema = z
  .object({
    queue: CrcAppointmentQueueSchema.default("new"),
    city: z.string().trim().min(1).max(100).optional(),
    showroom_id: optionalQueryIntegerSchema,
    workshop_id: optionalQueryIntegerSchema,
    date_from: IsoDateSchema.optional(),
    date_to: IsoDateSchema.optional(),
    limit: queryLimitSchema,
    offset: queryOffsetSchema,
  })
  .strict()
  .refine(
    (query) =>
      query.date_from === undefined ||
      query.date_to === undefined ||
      query.date_from <= query.date_to,
    {
      path: ["date_to"],
      message: "The end date must not precede the start date.",
    },
  );

const CrcCustomerSchema = z
  .object({
    id: positiveSafeIntegerSchema,
    first_name: z.string().trim().min(1).nullable(),
    last_name: z.string().trim().min(1).nullable(),
    email: z.string().trim().min(1).nullable(),
    phone: z.string().trim().min(1).nullable(),
  })
  .strict();

const CrcVehicleSchema = z
  .object({
    id: positiveSafeIntegerSchema,
    brand_name: z.string().trim().min(1).nullable(),
    model: z.string().trim().min(1).nullable(),
    registration_number: z.string().trim().min(1).nullable(),
  })
  .strict();

const CrcServiceTypeSchema = z
  .object({
    id: positiveSafeIntegerSchema,
    name: z.string().trim().min(1),
  })
  .strict();

const CrcShowroomSchema = z
  .object({
    id: positiveSafeIntegerSchema,
    name: z.string().trim().min(1),
    city: z.string().trim().min(1).nullable(),
    address: z.string().trim().min(1).nullable(),
  })
  .strict();

const CrcWorkshopSchema = z
  .object({
    id: positiveSafeIntegerSchema,
    name: z.string().trim().min(1),
    workshop_type: z.enum(ALLOWED_WORKSHOP_TYPES),
    showroom: CrcShowroomSchema,
  })
  .strict();

export const CrcAppointmentSchema = z
  .object({
    id: CrcAppointmentIdSchema,
    received_at: z.string().trim().min(1).nullable(),
    customer: CrcCustomerSchema.nullable(),
    vehicle: CrcVehicleSchema,
    service_type: CrcServiceTypeSchema,
    workshop: CrcWorkshopSchema,
    requested_date: IsoDateSchema,
    requested_time: IsoTimeSchema,
    status: CrcAppointmentStatusSchema,
    problem_summary: z.string().trim().min(1).nullable(),
  })
  .strict();

export const CrcAppointmentListSchema = z.array(CrcAppointmentSchema).max(100);

export type CrcAppointment = z.infer<typeof CrcAppointmentSchema>;
export type CrcAppointmentListQuery = z.infer<
  typeof CrcAppointmentListQuerySchema
>;
export type CrcAppointmentQueue = z.infer<typeof CrcAppointmentQueueSchema>;
export type CrcAppointmentStatus = z.infer<typeof CrcAppointmentStatusSchema>;
