import { z } from "zod";

import { ALLOWED_WORKSHOP_TYPES } from "../../domain/ai-diagnostic/index.js";
import {
  CRC_APPOINTMENT_STATUSES,
  CrcAppointmentListSchema,
  CrcAppointmentSchema,
  type CrcAppointment,
  type CrcAppointmentListQuery,
  type CrcAppointmentQueue,
  type CrcAppointmentStatus,
} from "../../domain/crc-appointments/index.js";
import { IsoDateSchema } from "../../domain/ai-booking/index.js";
import { DirectusError } from "./directus-errors.js";
import type { DirectusReadClient } from "./directus-http-client.js";

const positiveSafeIntegerSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);

const directusTimeSchema = z
  .string()
  .regex(/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/)
  .transform((time) => (time.length === 5 ? `${time}:00` : time));

const nullableTrimmedStringSchema = z
  .string()
  .trim()
  .min(1)
  .nullable();

const directusAppointmentSchema = z
  .object({
    id: positiveSafeIntegerSchema,
    customer_id: z
      .object({
        id: positiveSafeIntegerSchema,
        first_name: nullableTrimmedStringSchema,
        last_name: nullableTrimmedStringSchema,
        email: nullableTrimmedStringSchema,
        phone: nullableTrimmedStringSchema,
      })
      .strict()
      .nullable(),
    vehicle_id: z
      .object({
        id: positiveSafeIntegerSchema,
        brand_id: z
          .object({
            id: positiveSafeIntegerSchema,
            name: nullableTrimmedStringSchema,
          })
          .strict()
          .nullable(),
        model: nullableTrimmedStringSchema,
        registration_number: nullableTrimmedStringSchema,
      })
      .strict(),
    service_type_id: z
      .object({
        id: positiveSafeIntegerSchema,
        name: z.string().trim().min(1),
      })
      .strict(),
    workshop_id: z
      .object({
        id: positiveSafeIntegerSchema,
        name: z.string().trim().min(1),
        workshop_type: z.enum(ALLOWED_WORKSHOP_TYPES),
        showroom_id: z
          .object({
            id: positiveSafeIntegerSchema,
            name: z.string().trim().min(1),
            city: nullableTrimmedStringSchema,
            address: nullableTrimmedStringSchema,
          })
          .strict(),
      })
      .strict(),
    requested_date: IsoDateSchema,
    requested_time: directusTimeSchema,
    status: z.enum(CRC_APPOINTMENT_STATUSES),
    comment: nullableTrimmedStringSchema,
  })
  .strict();

const directusAppointmentListResponseSchema = z
  .object({ data: z.array(directusAppointmentSchema).max(100) })
  .strict();

const directusAppointmentResponseSchema = z
  .object({ data: directusAppointmentSchema })
  .strict();

const APPOINTMENT_FIELDS = [
  "id",
  "customer_id.id",
  "customer_id.first_name",
  "customer_id.last_name",
  "customer_id.email",
  "customer_id.phone",
  "vehicle_id.id",
  "vehicle_id.brand_id.id",
  "vehicle_id.brand_id.name",
  "vehicle_id.model",
  "vehicle_id.registration_number",
  "service_type_id.id",
  "service_type_id.name",
  "workshop_id.id",
  "workshop_id.name",
  "workshop_id.workshop_type",
  "workshop_id.showroom_id.id",
  "workshop_id.showroom_id.name",
  "workshop_id.showroom_id.city",
  "workshop_id.showroom_id.address",
  "requested_date",
  "requested_time",
  "status",
  "comment",
] as const;

const statusesByQueue: Record<
  CrcAppointmentQueue,
  readonly CrcAppointmentStatus[]
> = {
  new: ["pending"],
  callback: ["callback_pending"],
  proposed: ["alternative_proposed"],
  processed: ["confirmed", "rejected", "cancelled", "arrived"],
};

const mapAppointment = (
  appointment: z.infer<typeof directusAppointmentSchema>,
): CrcAppointment =>
  CrcAppointmentSchema.parse({
    id: appointment.id,
    received_at: null,
    customer: appointment.customer_id,
    vehicle: {
      id: appointment.vehicle_id.id,
      brand_name: appointment.vehicle_id.brand_id?.name ?? null,
      model: appointment.vehicle_id.model,
      registration_number: appointment.vehicle_id.registration_number,
    },
    service_type: appointment.service_type_id,
    workshop: {
      id: appointment.workshop_id.id,
      name: appointment.workshop_id.name,
      workshop_type: appointment.workshop_id.workshop_type,
      showroom: appointment.workshop_id.showroom_id,
    },
    requested_date: appointment.requested_date,
    requested_time: appointment.requested_time,
    status: appointment.status,
    problem_summary: appointment.comment,
  });

export interface DirectusCrcAppointmentsService {
  listAppointments(
    accessToken: string,
    query: CrcAppointmentListQuery,
  ): Promise<CrcAppointment[]>;
  getAppointment(
    accessToken: string,
    appointmentId: number,
  ): Promise<CrcAppointment | null>;
}

export const createDirectusCrcAppointmentsService = (
  client: DirectusReadClient,
): DirectusCrcAppointmentsService => ({
  async listAppointments(accessToken, query) {
    const searchParams = new URLSearchParams([
      ["fields", APPOINTMENT_FIELDS.join(",")],
      ["filter[status][_in]", statusesByQueue[query.queue].join(",")],
      ["sort", "id"],
      ["limit", String(query.limit)],
      ["offset", String(query.offset)],
    ]);

    if (query.city !== undefined) {
      searchParams.set(
        "filter[workshop_id][showroom_id][city][_eq]",
        query.city,
      );
    }
    if (query.showroom_id !== undefined) {
      searchParams.set(
        "filter[workshop_id][showroom_id][_eq]",
        String(query.showroom_id),
      );
    }
    if (query.workshop_id !== undefined) {
      searchParams.set(
        "filter[workshop_id][_eq]",
        String(query.workshop_id),
      );
    }
    if (query.date_from !== undefined) {
      searchParams.set(
        "filter[requested_date][_gte]",
        query.date_from,
      );
    }
    if (query.date_to !== undefined) {
      searchParams.set("filter[requested_date][_lte]", query.date_to);
    }

    const payload = await client.getJson(
      "/items/appointments",
      searchParams,
      accessToken,
    );
    const parsed = directusAppointmentListResponseSchema.safeParse(payload);
    if (!parsed.success) {
      throw new DirectusError("DIRECTUS_INVALID_RESPONSE");
    }

    return CrcAppointmentListSchema.parse(parsed.data.data.map(mapAppointment));
  },

  async getAppointment(accessToken, appointmentId) {
    try {
      const payload = await client.getJson(
        `/items/appointments/${appointmentId}`,
        new URLSearchParams([["fields", APPOINTMENT_FIELDS.join(",")]]),
        accessToken,
      );
      const parsed = directusAppointmentResponseSchema.safeParse(payload);
      if (!parsed.success || parsed.data.data.id !== appointmentId) {
        throw new DirectusError("DIRECTUS_INVALID_RESPONSE");
      }
      return mapAppointment(parsed.data.data);
    } catch (error: unknown) {
      if (
        error instanceof DirectusError &&
        error.code === "DIRECTUS_NOT_FOUND"
      ) {
        return null;
      }
      throw error;
    }
  },
});
