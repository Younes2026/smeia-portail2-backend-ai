import { z } from "zod";

import {
  CrcAppointmentIdSchema,
  CrcAppointmentStatusSchema,
  CrcIdempotencyKeySchema,
  CrcRejectionReasonCodeSchema,
  type CrcAppointmentStatus,
  type CrcRejectionReasonCode,
} from "../../domain/crc-appointments/index.js";
import {
  BookingPhysicalWorkshopIdSchema,
  BookingShowroomIdSchema,
  BookingVehicleIdSchema,
  IsoDateSchema,
  IsoTimeSchema,
} from "../../domain/ai-booking/index.js";
import {
  describeDirectusJsonResponse,
  DirectusError,
  mapDirectusHttpStatus,
  type DirectusResponseDiagnostic,
} from "./directus-errors.js";
import type { DirectusFetch } from "./directus-http-client.js";

export const CRC_EVENT_TYPES = [
  "callback_requested",
  "rejected",
  "confirmed",
] as const;

const crcEventTypeSchema = z.enum(CRC_EVENT_TYPES);
const directusItemIdentifierSchema = z
  .union([
    z.string().trim().min(1),
    z.number().int().safe(),
  ])
  .transform(String);
const directusAppointmentIdentifierSchema = z
  .union([
    CrcAppointmentIdSchema,
    z.string().trim().regex(/^[1-9]\d*$/).transform(Number),
  ])
  .pipe(CrcAppointmentIdSchema);
const directusAppointmentRelationSchema = z
  .union([
    directusAppointmentIdentifierSchema,
    z.object({ id: directusAppointmentIdentifierSchema }).passthrough(),
  ])
  .transform((value) => (typeof value === "number" ? value : value.id));

const directusTimeSchema = z
  .string()
  .regex(/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/)
  .transform((time) => (time.length === 5 ? `${time}:00` : time));

const directusWorkshopRelationSchema = z
  .union([
    directusAppointmentIdentifierSchema,
    z
      .object({ id: directusAppointmentIdentifierSchema })
      .passthrough(),
  ])
  .transform((relation) =>
    typeof relation === "number" ? relation : relation.id,
  );

const positiveSafeIntegerSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);

const createDirectusRelationSchema = (
  identifierSchema: z.ZodType<number>,
) => {
  const directusIdentifierSchema = z.preprocess(
    (value) =>
      typeof value === "string" && /^[1-9]\d*$/.test(value.trim())
        ? Number(value.trim())
        : value,
    identifierSchema,
  );

  return (
  z
    .union([
      directusIdentifierSchema,
      z.object({ id: directusIdentifierSchema }).passthrough(),
    ])
    .transform((relation) => {
      if (
        typeof relation === "object" &&
        relation !== null &&
        "id" in relation
      ) {
        return relation.id;
      }
      return relation;
    })
  );
};

const directusVehicleRelationSchema = createDirectusRelationSchema(
  BookingVehicleIdSchema,
);
const directusServiceTypeRelationSchema = createDirectusRelationSchema(
  positiveSafeIntegerSchema,
);
const directusShowroomRelationSchema = createDirectusRelationSchema(
  BookingShowroomIdSchema,
);

const crcAppointmentActionContextSchema = z
  .object({
    id: CrcAppointmentIdSchema,
    status: CrcAppointmentStatusSchema,
    requestedDate: IsoDateSchema,
    requestedTime: IsoTimeSchema,
    vehicleId: BookingVehicleIdSchema,
    serviceTypeId: positiveSafeIntegerSchema,
    workshopId: BookingPhysicalWorkshopIdSchema,
    showroomId: BookingShowroomIdSchema,
  })
  .strict();

const directusAppointmentActionContextSchema = z
  .object({
    id: directusAppointmentIdentifierSchema,
    status: CrcAppointmentStatusSchema,
    requested_date: IsoDateSchema,
    requested_time: directusTimeSchema,
    vehicle_id: directusVehicleRelationSchema,
    service_type_id: directusServiceTypeRelationSchema,
    workshop_id: z
      .object({
        id: directusAppointmentIdentifierSchema,
        showroom_id: directusShowroomRelationSchema,
      })
      .strict(),
  })
  .strict()
  .transform((appointment) =>
    crcAppointmentActionContextSchema.parse({
      id: appointment.id,
      status: appointment.status,
      requestedDate: appointment.requested_date,
      requestedTime: appointment.requested_time,
      vehicleId: appointment.vehicle_id,
      serviceTypeId: appointment.service_type_id,
      workshopId: appointment.workshop_id.id,
      showroomId: appointment.workshop_id.showroom_id,
    }),
  );

const directusAppointmentActionContextResponseSchema = z
  .object({ data: directusAppointmentActionContextSchema })
  .strict();

const directusAppointmentSlotUpdateSchema = z
  .object({
    requestedDate: IsoDateSchema,
    requestedTime: IsoTimeSchema,
  })
  .strict();

const crcAppointmentObservedStateSchema = z
  .object({
    id: CrcAppointmentIdSchema,
    status: CrcAppointmentStatusSchema,
  })
  .strict();

const directusAppointmentObservedStateSchema = z
  .object({
    id: directusAppointmentIdentifierSchema,
    status: CrcAppointmentStatusSchema,
  })
  .passthrough()
  .transform((appointment) => ({
    id: appointment.id,
    status: appointment.status,
  }));

const directusAppointmentStatusResponseSchema = z
  .object({ data: directusAppointmentObservedStateSchema })
  .passthrough();

const directusAppointmentTransitionStateSchema = z
  .object({
    id: directusAppointmentIdentifierSchema,
    status: CrcAppointmentStatusSchema,
    requested_date: IsoDateSchema,
    requested_time: directusTimeSchema,
    workshop_id: directusWorkshopRelationSchema,
  })
  .passthrough()
  .transform((appointment) => ({
    id: appointment.id,
    status: appointment.status,
    requestedDate: appointment.requested_date,
    requestedTime: appointment.requested_time,
    workshopId: appointment.workshop_id,
  }));

const directusAppointmentTransitionStateResponseSchema = z
  .object({ data: directusAppointmentTransitionStateSchema })
  .passthrough();

const APPOINTMENT_ACTION_CONTEXT_FIELDS = [
  "id",
  "status",
  "requested_date",
  "requested_time",
  "vehicle_id.id",
  "service_type_id.id",
  "workshop_id.id",
  "workshop_id.showroom_id.id",
] as const;

const CONDITIONAL_APPOINTMENT_UPDATE_FIELDS = [
  "id",
  "status",
  "requested_date",
  "requested_time",
  "workshop_id",
] as const;

const CONDITIONAL_APPOINTMENT_STATUS_UPDATE_FIELDS = [
  "id",
  "status",
] as const;

const IDEMPOTENCY_LOOKUP_FIELDS = [
  "id",
  "idempotency_key",
  "request_fingerprint",
  "event_type",
  "appointment_id",
  "status_to",
] as const;

const IDEMPOTENCY_REPLAY_FIELDS = [
  ...IDEMPOTENCY_LOOKUP_FIELDS,
  "status_from",
] as const;

const directusIdempotencyEventLookupSchema = z
  .object({
    id: directusItemIdentifierSchema,
    idempotency_key: CrcIdempotencyKeySchema,
    request_fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    event_type: crcEventTypeSchema,
    appointment_id: directusAppointmentRelationSchema,
    status_to: z.enum(["callback_pending", "rejected", "confirmed"]),
  })
  .strict();

const directusIdempotencyEventListResponseSchema = z
  .object({ data: z.array(directusIdempotencyEventLookupSchema).max(1) })
  .strict();

const directusReplayEventSchema = directusIdempotencyEventLookupSchema
  .extend({
    status_from: z.enum(["pending", "callback_pending"]),
  })
  .strict();

const directusReplayEventResponseSchema = z
  .object({ data: directusReplayEventSchema })
  .strict();

type DirectusConditionalPatchPayload =
  | { kind: "no_match" }
  | { kind: "candidate"; item: unknown }
  | { kind: "verify_by_read" };

const inspectConditionalPatchPayload = (
  payload: unknown,
): DirectusConditionalPatchPayload => {
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload)
  ) {
    return { kind: "verify_by_read" };
  }
  const data = Reflect.get(payload, "data");
  if (!Array.isArray(data)) {
    return { kind: "verify_by_read" };
  }
  if (data.length === 0) {
    return { kind: "no_match" };
  }
  if (data.length !== 1) {
    throw new DirectusError(
      "DIRECTUS_INVALID_RESPONSE",
      200,
      describeDirectusJsonResponse(payload),
    );
  }
  return { kind: "candidate", item: data[0] };
};

export type CrcEventType = (typeof CRC_EVENT_TYPES)[number];

export type CrcDirectusActionStep =
  | "CRC_APPOINTMENT_READ"
  | "CRC_SLOT_VERIFY"
  | "CRC_SLOT_REVALIDATE"
  | "CRC_CONDITIONAL_PATCH"
  | "CRC_PATCH_VERIFY_READ"
  | "CRC_EVENT_CREATE";

export class CrcDirectusActionStepError extends DirectusError {
  readonly step: CrcDirectusActionStep | undefined;
  readonly diagnostic: DirectusResponseDiagnostic | undefined;

  constructor(cause: DirectusError, step?: CrcDirectusActionStep) {
    super(cause.code, cause.httpStatus, cause.responseDiagnostic);
    this.name = "CrcDirectusActionStepError";
    this.step = step;
    this.diagnostic = cause.responseDiagnostic;
  }
}

export type DirectusCrcAppointmentReplayEvent = z.infer<
  typeof directusReplayEventSchema
>;

export type DirectusCrcAppointmentEventCreateResult = {
  eventId?: string;
};

export type DirectusCrcAppointmentEventCreateInput = {
  appointment_id: number;
  event_type: CrcEventType;
  actor_user_id: string;
  status_from: CrcAppointmentStatus;
  status_to: CrcAppointmentStatus;
  reason_code?: CrcRejectionReasonCode;
  callback_due_at?: string;
  public_message?: string;
  internal_note?: string;
  idempotency_key: string;
  request_fingerprint: string;
};

export type DirectusCrcAppointmentActionContext = z.infer<
  typeof crcAppointmentActionContextSchema
>;

export type DirectusCrcAppointmentObservedState = z.infer<
  typeof crcAppointmentObservedStateSchema
>;

export type DirectusCrcAppointmentSlotUpdate = z.infer<
  typeof directusAppointmentSlotUpdateSchema
>;

export type DirectusCrcAppointmentActionsServiceConfig = {
  baseUrl: string;
  timeoutMs: number;
  fetchImplementation?: DirectusFetch;
};

export interface DirectusCrcAppointmentActionsService {
  findEventByIdempotencyKey(
    technicalToken: string,
    idempotencyKey: string,
  ): Promise<DirectusCrcAppointmentReplayEvent | null>;
  getAppointmentStatus(
    technicalToken: string,
    appointmentId: number,
  ): Promise<CrcAppointmentStatus | null>;
  getAppointment(
    technicalToken: string,
    appointmentId: number,
  ): Promise<DirectusCrcAppointmentActionContext | null>;
  updateAppointmentStatus(
    technicalToken: string,
    observedAppointment:
      | DirectusCrcAppointmentObservedState
      | DirectusCrcAppointmentActionContext,
    targetStatus: CrcAppointmentStatus,
    slotUpdate?: DirectusCrcAppointmentSlotUpdate,
  ): Promise<boolean>;
  createEvent(
    technicalToken: string,
    input: DirectusCrcAppointmentEventCreateInput,
  ): Promise<DirectusCrcAppointmentEventCreateResult>;
}

const parseBaseUrl = (value: string) => {
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username.length > 0 ||
      url.password.length > 0
    ) {
      throw new Error("Invalid Directus URL.");
    }
    url.search = "";
    url.hash = "";
    return url;
  } catch {
    throw new DirectusError("DIRECTUS_ERROR");
  }
};

const buildItemsUrl = (
  baseUrl: URL,
  collection: "appointments" | "appointment_crc_events",
  searchParams: URLSearchParams,
) => {
  const url = new URL(baseUrl);
  const basePath = url.pathname.replace(/\/+$/, "");
  url.pathname = `${basePath}/items/${collection}`;
  url.search = searchParams.toString();
  return url;
};

const buildItemUrl = (
  baseUrl: URL,
  collection: "appointments" | "appointment_crc_events",
  itemId: number | string,
  searchParams: URLSearchParams,
) => {
  const url = buildItemsUrl(baseUrl, collection, searchParams);
  url.pathname = `${url.pathname}/${itemId}`;
  return url;
};

const parseJson = async (response: Response) => {
  const responseText = await response.text();
  if (responseText.trim().length === 0) {
    throw new DirectusError("DIRECTUS_INVALID_RESPONSE", response.status, {
      directus_http_status: response.status,
      response_kind: "empty",
      data_kind: "missing",
    });
  }
  try {
    return JSON.parse(responseText) as unknown;
  } catch {
    throw new DirectusError("DIRECTUS_INVALID_RESPONSE", response.status, {
      directus_http_status: response.status,
      response_kind: "non_json",
      data_kind: "missing",
    });
  }
};

const buildAuthorizationHeader = (token: string) => {
  const normalizedToken = token.trim();
  return normalizedToken.length === 0
    ? undefined
    : `Bearer ${normalizedToken}`;
};

const getCreatedEventId = (payload: unknown) => {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return undefined;
  }
  const data = Reflect.get(payload, "data");
  const rawId =
    typeof data === "object" && data !== null && !Array.isArray(data)
      ? Reflect.get(data, "id")
      : data;
  const parsed = directusItemIdentifierSchema.safeParse(rawId);
  return parsed.success ? parsed.data : undefined;
};

export const createDirectusCrcAppointmentActionsService = (
  config: DirectusCrcAppointmentActionsServiceConfig,
): DirectusCrcAppointmentActionsService => {
  const baseUrl = parseBaseUrl(config.baseUrl);
  const fetchImplementation = config.fetchImplementation ?? fetch;

  const requestWithMetadata = async (
    url: URL,
    technicalToken: string,
    init: Omit<RequestInit, "headers" | "signal">,
    options: { allowInvalidSuccessPayload?: boolean } = {},
  ) => {
    const authorizationHeader = buildAuthorizationHeader(technicalToken);
    if (authorizationHeader === undefined) {
      throw new DirectusError("DIRECTUS_UNAUTHORIZED");
    }

    const abortController = new AbortController();
    const timeout = setTimeout(
      () => abortController.abort(),
      config.timeoutMs,
    );
    try {
      const response = await fetchImplementation(url, {
        ...init,
        headers: {
          Accept: "application/json",
          Authorization: authorizationHeader,
          ...(init.body === undefined
            ? {}
            : { "Content-Type": "application/json" }),
        },
        signal: abortController.signal,
      });
      if (!response.ok) {
        const mapped = mapDirectusHttpStatus(response.status);
        throw new DirectusError(mapped.code, response.status, {
          directus_http_status: response.status,
          response_kind: response.headers
            .get("content-type")
            ?.toLowerCase()
            .includes("json")
            ? "json"
            : "non_json",
          data_kind: "missing",
        });
      }
      try {
        return {
          payload: await parseJson(response),
          httpStatus: response.status,
        };
      } catch (error: unknown) {
        if (
          options.allowInvalidSuccessPayload === true &&
          error instanceof DirectusError &&
          error.code === "DIRECTUS_INVALID_RESPONSE"
        ) {
          return { payload: undefined, httpStatus: response.status };
        }
        throw error;
      }
    } catch (error: unknown) {
      if (error instanceof DirectusError) {
        throw error;
      }
      if (abortController.signal.aborted) {
        throw new DirectusError("DIRECTUS_TIMEOUT");
      }
      throw new DirectusError("DIRECTUS_UNAVAILABLE");
    } finally {
      clearTimeout(timeout);
    }
  };

  const request = async (
    url: URL,
    technicalToken: string,
    init: Omit<RequestInit, "headers" | "signal">,
  ) => (await requestWithMetadata(url, technicalToken, init)).payload;

  const readAppointmentStatus = async (
    technicalToken: string,
    appointmentId: number,
  ) => {
    const payload = await request(
      buildItemUrl(
        baseUrl,
        "appointments",
        appointmentId,
        new URLSearchParams([[
          "fields",
          CONDITIONAL_APPOINTMENT_STATUS_UPDATE_FIELDS.join(","),
        ]]),
      ),
      technicalToken,
      { method: "GET" },
    );
    const parsed = directusAppointmentStatusResponseSchema.safeParse(payload);
    if (!parsed.success || parsed.data.data.id !== appointmentId) {
      throw new DirectusError(
        "DIRECTUS_INVALID_RESPONSE",
        200,
        describeDirectusJsonResponse(payload),
      );
    }
    return parsed.data.data;
  };

  const readAppointmentTransitionState = async (
    technicalToken: string,
    appointmentId: number,
  ) => {
    const payload = await request(
      buildItemUrl(
        baseUrl,
        "appointments",
        appointmentId,
        new URLSearchParams([[
          "fields",
          CONDITIONAL_APPOINTMENT_UPDATE_FIELDS.join(","),
        ]]),
      ),
      technicalToken,
      { method: "GET" },
    );
    const parsed =
      directusAppointmentTransitionStateResponseSchema.safeParse(payload);
    if (!parsed.success || parsed.data.data.id !== appointmentId) {
      throw new DirectusError(
        "DIRECTUS_INVALID_RESPONSE",
        200,
        describeDirectusJsonResponse(payload),
      );
    }
    return parsed.data.data;
  };

  const runStep = async <T>(
    step: CrcDirectusActionStep,
    operation: () => Promise<T>,
  ): Promise<T> => {
    try {
      return await operation();
    } catch (error: unknown) {
      if (error instanceof CrcDirectusActionStepError) {
        throw error;
      }
      if (error instanceof DirectusError) {
        throw new CrcDirectusActionStepError(error, step);
      }
      throw error;
    }
  };

  return {
    async findEventByIdempotencyKey(technicalToken, idempotencyKey) {
      const parsedKey = CrcIdempotencyKeySchema.parse(idempotencyKey);
      const lookupEvent = await runStep("CRC_EVENT_CREATE", async () => {
          const searchParams = new URLSearchParams([
            ["fields", IDEMPOTENCY_LOOKUP_FIELDS.join(",")],
            ["filter[idempotency_key][_eq]", parsedKey],
            ["limit", "1"],
          ]);
          const payload = await request(
            buildItemsUrl(baseUrl, "appointment_crc_events", searchParams),
            technicalToken,
            { method: "GET" },
          );
          const parsed =
            directusIdempotencyEventListResponseSchema.safeParse(payload);
          if (!parsed.success) {
            throw new DirectusError(
              "DIRECTUS_INVALID_RESPONSE",
              200,
              describeDirectusJsonResponse(payload),
            );
          }
          return parsed.data.data[0] ?? null;
      });
      if (lookupEvent === null) {
        return null;
      }

      return runStep("CRC_EVENT_CREATE", async () => {
          const replayPayload = await request(
            buildItemUrl(
              baseUrl,
              "appointment_crc_events",
              lookupEvent.id,
              new URLSearchParams([
                ["fields", IDEMPOTENCY_REPLAY_FIELDS.join(",")],
              ]),
            ),
            technicalToken,
            { method: "GET" },
          );
          const replayEvent =
            directusReplayEventResponseSchema.safeParse(replayPayload);
          if (
            !replayEvent.success ||
            replayEvent.data.data.id !== lookupEvent.id ||
            replayEvent.data.data.idempotency_key !== parsedKey
          ) {
            throw new DirectusError(
              "DIRECTUS_INVALID_RESPONSE",
              200,
              describeDirectusJsonResponse(replayPayload),
            );
          }
          return replayEvent.data.data;
      });
    },

    async getAppointmentStatus(technicalToken, appointmentId) {
      return runStep("CRC_APPOINTMENT_READ", async () => {
        const id = CrcAppointmentIdSchema.parse(appointmentId);
        try {
          return (await readAppointmentStatus(technicalToken, id)).status;
        } catch (error: unknown) {
          if (
            error instanceof DirectusError &&
            error.code === "DIRECTUS_NOT_FOUND"
          ) {
            return null;
          }
          throw error;
        }
      });
    },

    async getAppointment(technicalToken, appointmentId) {
      return runStep("CRC_APPOINTMENT_READ", async () => {
        const id = CrcAppointmentIdSchema.parse(appointmentId);
        try {
          const payload = await request(
            buildItemUrl(
              baseUrl,
              "appointments",
              id,
              new URLSearchParams([
                ["fields", APPOINTMENT_ACTION_CONTEXT_FIELDS.join(",")],
              ]),
            ),
            technicalToken,
            { method: "GET" },
          );
          const parsed =
            directusAppointmentActionContextResponseSchema.safeParse(payload);
          if (!parsed.success || parsed.data.data.id !== id) {
            throw new DirectusError(
              "DIRECTUS_INVALID_RESPONSE",
              200,
              describeDirectusJsonResponse(payload),
            );
          }
          return parsed.data.data;
        } catch (error: unknown) {
          if (
            error instanceof DirectusError &&
            error.code === "DIRECTUS_NOT_FOUND"
          ) {
            return null;
          }
          throw error;
        }
      });
    },

    async updateAppointmentStatus(
      technicalToken,
      observedAppointment,
      targetStatus,
      rawSlotUpdate,
    ) {
      return runStep("CRC_CONDITIONAL_PATCH", async () => {
        const target = CrcAppointmentStatusSchema.parse(targetStatus);
        if (rawSlotUpdate === undefined) {
          const observed = crcAppointmentObservedStateSchema.parse({
            id: observedAppointment.id,
            status: observedAppointment.status,
          });
          const { payload } = await requestWithMetadata(
            buildItemsUrl(
              baseUrl,
              "appointments",
              new URLSearchParams([
                [
                  "fields",
                  CONDITIONAL_APPOINTMENT_STATUS_UPDATE_FIELDS.join(","),
                ],
              ]),
            ),
            technicalToken,
            {
              method: "PATCH",
              body: JSON.stringify({
                query: {
                  filter: {
                    id: { _eq: observed.id },
                    status: { _eq: observed.status },
                  },
                  limit: 1,
                },
                data: { status: target },
              }),
            },
            { allowInvalidSuccessPayload: true },
          );
          const inspected = inspectConditionalPatchPayload(payload);
          if (inspected.kind === "no_match") {
            return false;
          }
          if (inspected.kind === "candidate") {
            const updated = directusAppointmentObservedStateSchema.safeParse(
              inspected.item,
            );
            if (updated.success) {
              return (
                updated.data.id === observed.id &&
                updated.data.status === target
              );
            }
          }
          const verified = await runStep(
            "CRC_PATCH_VERIFY_READ",
            () => readAppointmentStatus(technicalToken, observed.id),
          );
          return verified.status === target;
        }

        const observed = crcAppointmentActionContextSchema.parse(
          observedAppointment,
        );
        const slotUpdate =
          directusAppointmentSlotUpdateSchema.parse(rawSlotUpdate);
        const requestedDate = slotUpdate.requestedDate;
        const requestedTime = slotUpdate.requestedTime;
        const body = {
          query: {
            filter: {
              id: { _eq: observed.id },
              status: { _eq: observed.status },
              requested_date: { _eq: observed.requestedDate },
              requested_time: { _eq: observed.requestedTime },
              workshop_id: { _eq: observed.workshopId },
            },
            limit: 1,
          },
          data: {
            status: target,
            requested_date: requestedDate,
            requested_time: requestedTime,
          },
        };
        const { payload } = await requestWithMetadata(
          buildItemsUrl(
            baseUrl,
            "appointments",
            new URLSearchParams([
              ["fields", CONDITIONAL_APPOINTMENT_UPDATE_FIELDS.join(",")],
            ]),
          ),
          technicalToken,
          { method: "PATCH", body: JSON.stringify(body) },
          { allowInvalidSuccessPayload: true },
        );
        const inspected = inspectConditionalPatchPayload(payload);
        if (inspected.kind === "no_match") {
          return false;
        }
        if (inspected.kind === "candidate") {
          const updated = directusAppointmentTransitionStateSchema.safeParse(
            inspected.item,
          );
          if (updated.success) {
            return (
              updated.data.id === observed.id &&
              updated.data.status === target &&
              updated.data.requestedDate === requestedDate &&
              updated.data.requestedTime === requestedTime &&
              updated.data.workshopId === observed.workshopId
            );
          }
        }
        const verified = await runStep(
          "CRC_PATCH_VERIFY_READ",
          () => readAppointmentTransitionState(technicalToken, observed.id),
        );
        return (
          verified.status === target &&
          verified.requestedDate === requestedDate &&
          verified.requestedTime === requestedTime &&
          verified.workshopId === observed.workshopId
        );
      });
    },

    async createEvent(technicalToken, input) {
      return runStep("CRC_EVENT_CREATE", async () => {
        const { payload } = await requestWithMetadata(
          buildItemsUrl(
            baseUrl,
            "appointment_crc_events",
            new URLSearchParams([["fields", "id"]]),
          ),
          technicalToken,
          { method: "POST", body: JSON.stringify(input) },
          { allowInvalidSuccessPayload: true },
        );
        const eventId = getCreatedEventId(payload);
        return eventId === undefined ? {} : { eventId };
      });
    },
  };
};
