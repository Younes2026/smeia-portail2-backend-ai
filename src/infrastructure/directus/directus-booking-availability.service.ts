import { z } from "zod";

import {
  ALLOWED_WORKSHOP_TYPES,
  type AiDiagnosticWorkshopType,
} from "../../domain/ai-diagnostic/index.js";
import {
  BOOKING_SEARCH_WINDOW_DAYS,
  BOOKING_WEEKDAYS,
  IsoDateSchema,
  type BookingAppointment,
  type BookingResource,
  type BookingSchedule,
  type BookingShowroom,
  type BookingWeekday,
  type BookingWorkshop,
  type DirectusBookingAvailabilitySnapshot,
} from "../../domain/ai-booking/index.js";
import { DirectusError } from "./directus-errors.js";
import type { DirectusReadClient } from "./directus-http-client.js";

const PAGE_SIZE = 200;
const MAX_RESOURCE_ROWS = 1_000;
const MAX_APPOINTMENT_ROWS = 10_000;

const positiveSafeIntegerSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);
const workshopIdSchema = positiveSafeIntegerSchema;
const workshopTypeSchema = z.enum(ALLOWED_WORKSHOP_TYPES);

export const DirectusWorkshopResolutionQuerySchema = z
  .object({
    showroomId: positiveSafeIntegerSchema,
    workshopTypes: z
      .array(workshopTypeSchema)
      .min(1)
      .max(2)
      .refine(
        (workshopTypes) =>
          new Set(workshopTypes).size === workshopTypes.length,
        { message: "Workshop types must be unique." },
      ),
  })
  .strict();

export type DirectusWorkshopResolutionQuery = z.infer<
  typeof DirectusWorkshopResolutionQuerySchema
>;

const workshopRelationSchema = z
  .union([
    workshopIdSchema,
    z.object({ id: workshopIdSchema }).strict(),
  ])
  .transform((relation) =>
    typeof relation === "number" ? relation : relation.id,
  );

const directusTimeSchema = z
  .string()
  .regex(/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/)
  .transform((time) => (time.length === 5 ? `${time}:00` : time));

const nonNegativeNumberSchema = z
  .union([
    z.number(),
    z.string().trim().regex(/^\d+(?:\.\d+)?$/).transform(Number),
  ])
  .pipe(z.number().finite().nonnegative());

const normalizeWorkingDays = (value: unknown) => {
  let entries = value;
  if (typeof value === "string") {
    try {
      entries = JSON.parse(value) as unknown;
    } catch {
      entries = value.split(",");
    }
  }

  if (!Array.isArray(entries)) {
    return entries;
  }

  return entries.map((entry) =>
    typeof entry === "string" ? entry.trim().toLowerCase() : entry,
  );
};

const workingDaysSchema = z.preprocess(
  normalizeWorkingDays,
  z.array(z.enum(BOOKING_WEEKDAYS)).min(1),
);

const directusShowroomSchema = z
  .object({
    id: z.number().int().positive(),
    name: z.string().trim().min(1),
    address: z.string().trim().min(1).nullable(),
    city: z.string().trim().min(1).nullable(),
    phone: z.string().trim().min(1).nullable(),
  })
  .strict();

const directusResolvedShowroomSchema = directusShowroomSchema
  .extend({ id: positiveSafeIntegerSchema })
  .strict();

const directusResolvedWorkshopSchema = z
  .object({
    id: positiveSafeIntegerSchema,
    name: z.string().trim().min(1),
    workshop_type: workshopTypeSchema,
    opening_time: directusTimeSchema,
    closing_time: directusTimeSchema,
    working_days: workingDaysSchema,
    slot_interval_minutes: z.number().int().positive().max(24 * 60),
    active: z.boolean(),
    client_bookable: z.boolean(),
    showroom_id: directusResolvedShowroomSchema,
  })
  .strict();

const directusWorkshopSchema = directusResolvedWorkshopSchema;

const directusScheduleSchema = z
  .object({
    workshop_id: workshopRelationSchema,
    date: IsoDateSchema,
    total_capacity_hours: nonNegativeNumberSchema,
    used_capacity_hours: nonNegativeNumberSchema,
    remaining_capacity_hours: nonNegativeNumberSchema,
  })
  .strict();

const directusResourceSchema = z
  .object({
    workshop_id: workshopRelationSchema,
    active: z.boolean(),
    daily_hours: nonNegativeNumberSchema.nullable(),
  })
  .strict();

const directusAppointmentSchema = z
  .object({
    workshop_id: workshopRelationSchema,
    requested_date: IsoDateSchema,
    requested_time: directusTimeSchema,
    status: z.string().trim().min(1),
  })
  .strict();

const createResponseSchema = <T extends z.ZodType>(itemSchema: T) =>
  z.object({ data: z.array(itemSchema) }).strict();

const workshopsResponseSchema = createResponseSchema(directusWorkshopSchema);
const resolvedWorkshopsResponseSchema = createResponseSchema(
  directusResolvedWorkshopSchema,
);
const schedulesResponseSchema = createResponseSchema(directusScheduleSchema);
const resourcesResponseSchema = createResponseSchema(directusResourceSchema);
const appointmentsResponseSchema = createResponseSchema(
  directusAppointmentSchema,
);

export type DirectusBookingAvailabilityQuery = {
  workshopIds: number[];
  showroomId: number;
  startDate: string;
  endDate: string;
};

export type ResolvedBookingWorkshop = {
  id: number;
  name: string;
  workshop_type: AiDiagnosticWorkshopType;
  opening_time: string;
  closing_time: string;
  working_days: BookingWeekday[];
  slot_interval_minutes: number;
  active: true;
  client_bookable: true;
  showroom: BookingShowroom;
};

export interface DirectusBookingAvailabilityService {
  resolveBookingWorkshops(
    accessToken: string,
    query: DirectusWorkshopResolutionQuery,
  ): Promise<ResolvedBookingWorkshop[]>;
  getBookingAvailabilitySnapshot(
    accessToken: string,
    query: DirectusBookingAvailabilityQuery,
  ): Promise<DirectusBookingAvailabilitySnapshot>;
}

const parsePayload = <T>(
  schema: z.ZodType<{ data: T[] }>,
  payload: unknown,
) => {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new DirectusError("DIRECTUS_INVALID_RESPONSE");
  }
  return parsed.data.data;
};

const getRangeDayCount = (startDate: string, endDate: string) => {
  const start = new Date(`${startDate}T00:00:00.000Z`).getTime();
  const end = new Date(`${endDate}T00:00:00.000Z`).getTime();
  return Math.floor((end - start) / 86_400_000) + 1;
};

const createCommonFilters = (
  query: DirectusBookingAvailabilityQuery,
  fields: string,
) => {
  const searchParams = new URLSearchParams([
    ["fields", fields],
    ["filter[workshop_id][_in]", query.workshopIds.join(",")],
  ]);
  return searchParams;
};

const assertRowsMatchQuery = (
  rows: ReadonlyArray<{ workshop_id: number }>,
  query: DirectusBookingAvailabilityQuery,
) => {
  const requestedWorkshopIds = new Set<number>(query.workshopIds);
  if (rows.some((row) => !requestedWorkshopIds.has(row.workshop_id))) {
    throw new DirectusError("DIRECTUS_INVALID_RESPONSE");
  }
};

const assertDatedRowsMatchQuery = (
  rows: ReadonlyArray<{ workshop_id: number; date: string }>,
  query: DirectusBookingAvailabilityQuery,
) => {
  assertRowsMatchQuery(rows, query);
  if (
    rows.some((row) => row.date < query.startDate || row.date > query.endDate)
  ) {
    throw new DirectusError("DIRECTUS_INVALID_RESPONSE");
  }
};

const readPagedRows = async <T>(
  client: DirectusReadClient,
  endpoint: string,
  baseSearchParams: URLSearchParams,
  accessToken: string,
  schema: z.ZodType<{ data: T[] }>,
  maximumRows: number,
) => {
  const rows: T[] = [];
  for (let offset = 0; offset < maximumRows; offset += PAGE_SIZE) {
    const searchParams = new URLSearchParams(baseSearchParams);
    searchParams.set("limit", String(PAGE_SIZE));
    searchParams.set("offset", String(offset));
    const payload = await client.getJson(endpoint, searchParams, accessToken);
    const page = parsePayload(schema, payload);
    if (rows.length + page.length > maximumRows) {
      throw new DirectusError("DIRECTUS_INVALID_RESPONSE");
    }
    rows.push(...page);

    if (page.length < PAGE_SIZE) {
      return rows;
    }
  }

  throw new DirectusError("DIRECTUS_INVALID_RESPONSE");
};

export const createDirectusBookingAvailabilityService = (
  client: DirectusReadClient,
): DirectusBookingAvailabilityService => ({
  async resolveBookingWorkshops(accessToken, query) {
    const parsedQuery = DirectusWorkshopResolutionQuerySchema.safeParse(query);
    if (!parsedQuery.success) {
      // This service already maps invalid internal queries to the controlled
      // DIRECTUS_INVALID_RESPONSE error (as does the snapshot method below).
      throw new DirectusError("DIRECTUS_INVALID_RESPONSE");
    }

    const { showroomId, workshopTypes } = parsedQuery.data;
    const workshopParams = new URLSearchParams([
      [
        "fields",
        "id,name,workshop_type,opening_time,closing_time,working_days,slot_interval_minutes,active,client_bookable,showroom_id.id,showroom_id.name,showroom_id.address,showroom_id.city,showroom_id.phone",
      ],
      ["filter[showroom_id][_eq]", String(showroomId)],
      ["filter[workshop_type][_in]", workshopTypes.join(",")],
      ["filter[active][_eq]", "true"],
      ["filter[client_bookable][_eq]", "true"],
      ["limit", String(workshopTypes.length + 1)],
    ]);

    const payload = await client.getJson(
      "/items/workshops",
      workshopParams,
      accessToken,
    );
    const workshops = parsePayload(resolvedWorkshopsResponseSchema, payload);
    if (workshops.length === 0) {
      throw new DirectusError("DIRECTUS_NOT_FOUND");
    }

    const requestedWorkshopTypes = new Set<AiDiagnosticWorkshopType>(
      workshopTypes,
    );
    const workshopByType = new Map<
      AiDiagnosticWorkshopType,
      (typeof workshops)[number]
    >();
    for (const workshop of workshops) {
      if (
        workshop.showroom_id.id !== showroomId ||
        !requestedWorkshopTypes.has(workshop.workshop_type) ||
        !workshop.active ||
        !workshop.client_bookable ||
        workshopByType.has(workshop.workshop_type)
      ) {
        throw new DirectusError("DIRECTUS_INVALID_RESPONSE");
      }
      workshopByType.set(workshop.workshop_type, workshop);
    }

    return workshopTypes.map((workshopType) => {
      const workshop = workshopByType.get(workshopType);
      if (workshop === undefined) {
        throw new DirectusError("DIRECTUS_NOT_FOUND");
      }

      return {
        id: workshop.id,
        name: workshop.name,
        workshop_type: workshop.workshop_type,
        opening_time: workshop.opening_time,
        closing_time: workshop.closing_time,
        working_days: workshop.working_days as BookingWeekday[],
        slot_interval_minutes: workshop.slot_interval_minutes,
        active: true,
        client_bookable: true,
        showroom: workshop.showroom_id,
      };
    });
  },

  async getBookingAvailabilitySnapshot(accessToken, query) {
    const parsedStartDate = IsoDateSchema.safeParse(query.startDate);
    const parsedEndDate = IsoDateSchema.safeParse(query.endDate);
    const rangeDayCount =
      parsedStartDate.success && parsedEndDate.success
        ? getRangeDayCount(query.startDate, query.endDate)
        : 0;
    if (
      !parsedStartDate.success ||
      !parsedEndDate.success ||
      query.startDate > query.endDate ||
      rangeDayCount < 1 ||
      rangeDayCount > BOOKING_SEARCH_WINDOW_DAYS ||
      !positiveSafeIntegerSchema.safeParse(query.showroomId).success ||
      query.workshopIds.length < 1 ||
      query.workshopIds.length > 2 ||
      new Set(query.workshopIds).size !== query.workshopIds.length ||
      query.workshopIds.some(
        (workshopId) => !workshopIdSchema.safeParse(workshopId).success,
      )
    ) {
      throw new DirectusError("DIRECTUS_INVALID_RESPONSE");
    }

    const workshopParams = new URLSearchParams([
      [
        "fields",
        "id,name,workshop_type,opening_time,closing_time,working_days,slot_interval_minutes,active,client_bookable,showroom_id.id,showroom_id.name,showroom_id.address,showroom_id.city,showroom_id.phone",
      ],
      ["filter[id][_in]", query.workshopIds.join(",")],
      ["filter[showroom_id][_eq]", String(query.showroomId)],
      ["filter[active][_eq]", "true"],
      ["filter[client_bookable][_eq]", "true"],
      ["sort", "id"],
      ["limit", String(query.workshopIds.length + 1)],
    ]);

    const scheduleParams = createCommonFilters(
      query,
      "workshop_id,date,total_capacity_hours,used_capacity_hours,remaining_capacity_hours",
    );
    scheduleParams.set("filter[date][_gte]", query.startDate);
    scheduleParams.set("filter[date][_lte]", query.endDate);
    scheduleParams.set("sort", "date,workshop_id");
    scheduleParams.set(
      "limit",
      String(query.workshopIds.length * rangeDayCount),
    );

    const resourceParams = createCommonFilters(
      query,
      "workshop_id,active,daily_hours",
    );
    resourceParams.set("filter[active][_eq]", "true");
    resourceParams.set("sort", "workshop_id");

    const appointmentParams = createCommonFilters(
      query,
      "workshop_id,requested_date,requested_time,status",
    );
    appointmentParams.set("filter[requested_date][_gte]", query.startDate);
    appointmentParams.set("filter[requested_date][_lte]", query.endDate);
    appointmentParams.set("filter[status][_in]", "pending,confirmed");
    appointmentParams.set(
      "sort",
      "requested_date,requested_time,workshop_id",
    );

    const [workshopsPayload, schedulesPayload, resources, appointments] =
      await Promise.all([
        client.getJson("/items/workshops", workshopParams, accessToken),
        client.getJson("/items/schedules", scheduleParams, accessToken),
        readPagedRows(
          client,
          "/items/resources",
          resourceParams,
          accessToken,
          resourcesResponseSchema,
          MAX_RESOURCE_ROWS,
        ),
        readPagedRows(
          client,
          "/items/appointments",
          appointmentParams,
          accessToken,
          appointmentsResponseSchema,
          MAX_APPOINTMENT_ROWS,
        ),
      ]);

    const directusWorkshops = parsePayload(
      workshopsResponseSchema,
      workshopsPayload,
    );
    const schedules = parsePayload(schedulesResponseSchema, schedulesPayload);
    const requestedWorkshopIds = new Set<number>(query.workshopIds);
    if (
      directusWorkshops.length !== query.workshopIds.length ||
      directusWorkshops.some(
        (workshop) =>
          !requestedWorkshopIds.has(workshop.id) ||
          workshop.showroom_id.id !== query.showroomId ||
          !workshop.active ||
          !workshop.client_bookable,
      )
    ) {
      throw new DirectusError("DIRECTUS_INVALID_RESPONSE");
    }

    assertDatedRowsMatchQuery(schedules, query);
    assertRowsMatchQuery(resources, query);
    assertRowsMatchQuery(appointments, query);
    if (
      appointments.some(
        (appointment) =>
          appointment.requested_date < query.startDate ||
          appointment.requested_date > query.endDate,
      )
    ) {
      throw new DirectusError("DIRECTUS_INVALID_RESPONSE");
    }

    const scheduleKeys = new Set<string>();
    for (const schedule of schedules) {
      const key = `${schedule.workshop_id}|${schedule.date}`;
      if (scheduleKeys.has(key)) {
        throw new DirectusError("DIRECTUS_INVALID_RESPONSE");
      }
      scheduleKeys.add(key);
    }

    const directusWorkshopById = new Map(
      directusWorkshops.map((workshop) => [workshop.id, workshop]),
    );
    if (directusWorkshopById.size !== query.workshopIds.length) {
      throw new DirectusError("DIRECTUS_INVALID_RESPONSE");
    }
    const workshops: BookingWorkshop[] = query.workshopIds.map(
      (workshopId) => {
        const workshop = directusWorkshopById.get(workshopId);
        if (workshop === undefined) {
          throw new DirectusError("DIRECTUS_INVALID_RESPONSE");
        }
        return {
          id: workshop.id,
          name: workshop.name,
          workshop_type: workshop.workshop_type,
          opening_time: workshop.opening_time,
          closing_time: workshop.closing_time,
          working_days: workshop.working_days as BookingWeekday[],
          slot_interval_minutes: workshop.slot_interval_minutes,
          active: workshop.active,
          client_bookable: workshop.client_bookable,
          showroom: workshop.showroom_id,
        };
      },
    );

    return {
      workshops,
      schedules: schedules as BookingSchedule[],
      resources: resources as BookingResource[],
      appointments: appointments as BookingAppointment[],
    };
  },
});
