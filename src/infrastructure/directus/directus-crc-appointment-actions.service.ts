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
  DirectusError,
  mapDirectusHttpStatus,
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
const directusAppointmentRelationSchema = z
  .union([
    CrcAppointmentIdSchema,
    z.object({ id: CrcAppointmentIdSchema }).passthrough(),
  ])
  .transform((value) => (typeof value === "number" ? value : value.id));

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

const directusAppointmentStatusResponseSchema = z
  .object({
    data: z
      .object({
        id: CrcAppointmentIdSchema,
        status: CrcAppointmentStatusSchema,
      })
      .strict(),
  })
  .strict();

export type CrcEventType = (typeof CRC_EVENT_TYPES)[number];

export class CrcDirectusActionStepError extends DirectusError {
  constructor(cause: DirectusError) {
    super(cause.code, cause.httpStatus);
    this.name = "CrcDirectusActionStepError";
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
  updateAppointmentStatus(
    technicalToken: string,
    appointmentId: number,
    observedStatus: CrcAppointmentStatus,
    targetStatus: CrcAppointmentStatus,
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
  try {
    return (await response.json()) as unknown;
  } catch {
    throw new DirectusError("DIRECTUS_INVALID_RESPONSE");
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
        throw mapDirectusHttpStatus(response.status);
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

  const runStep = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation();
    } catch (error: unknown) {
      if (error instanceof DirectusError) {
        throw new CrcDirectusActionStepError(error);
      }
      throw error;
    }
  };

  return {
    async findEventByIdempotencyKey(technicalToken, idempotencyKey) {
      const parsedKey = CrcIdempotencyKeySchema.parse(idempotencyKey);
      const lookupEvent = await runStep(async () => {
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
            throw new DirectusError("DIRECTUS_INVALID_RESPONSE", 200);
          }
          return parsed.data.data[0] ?? null;
      });
      if (lookupEvent === null) {
        return null;
      }

      return runStep(async () => {
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
            throw new DirectusError("DIRECTUS_INVALID_RESPONSE", 200);
          }
          return replayEvent.data.data;
      });
    },

    async getAppointmentStatus(technicalToken, appointmentId) {
      return runStep(async () => {
        const id = CrcAppointmentIdSchema.parse(appointmentId);
        try {
          const payload = await request(
            buildItemUrl(
              baseUrl,
              "appointments",
              id,
              new URLSearchParams([["fields", "id,status"]]),
            ),
            technicalToken,
            { method: "GET" },
          );
          const parsed = directusAppointmentStatusResponseSchema.safeParse(
            payload,
          );
          if (!parsed.success || parsed.data.data.id !== id) {
            throw new DirectusError("DIRECTUS_INVALID_RESPONSE", 200);
          }
          return parsed.data.data.status;
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
      appointmentId,
      observedStatus,
      targetStatus,
    ) {
      return runStep(async () => {
        const id = CrcAppointmentIdSchema.parse(appointmentId);
        CrcAppointmentStatusSchema.parse(observedStatus);
        const target = CrcAppointmentStatusSchema.parse(targetStatus);
        const payload = await request(
          buildItemUrl(
            baseUrl,
            "appointments",
            id,
            new URLSearchParams([["fields", "id,status"]]),
          ),
          technicalToken,
          { method: "PATCH", body: JSON.stringify({ status: target }) },
        );
        const parsed = directusAppointmentStatusResponseSchema.safeParse(
          payload,
        );
        if (
          !parsed.success ||
          parsed.data.data.id !== id ||
          parsed.data.data.status !== target
        ) {
          throw new DirectusError("DIRECTUS_INVALID_RESPONSE", 200);
        }
        return true;
      });
    },

    async createEvent(technicalToken, input) {
      return runStep(async () => {
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
