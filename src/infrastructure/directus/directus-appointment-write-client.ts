import { z } from "zod";

import {
  BookingPhysicalWorkshopIdSchema,
  BookingShowroomIdSchema,
  BookingVehicleIdSchema,
  IsoDateSchema,
  IsoTimeSchema,
} from "../../domain/ai-booking/index.js";
import { ALLOWED_SERVICE_TYPE_IDS } from "../../domain/ai-diagnostic/index.js";
import {
  DirectusError,
  mapDirectusHttpStatus,
} from "./directus-errors.js";
import type { DirectusFetch } from "./directus-http-client.js";

export const DirectusAppointmentCreateInputSchema = z
  .object({
    customer_id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    vehicle_id: BookingVehicleIdSchema,
    service_type_id: z.literal(ALLOWED_SERVICE_TYPE_IDS),
    workshop_id: BookingPhysicalWorkshopIdSchema,
    showroom_id: BookingShowroomIdSchema,
    requested_date: IsoDateSchema,
    requested_time: IsoTimeSchema,
    comment: z.string().trim().min(10).max(1_000),
  })
  .strict();

const directusCreatedAppointmentResponseSchema = z
  .object({
    data: z
      .object({
        id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        status: z.literal("pending"),
      })
      .strict(),
  })
  .strict();

export type DirectusAppointmentCreateInput = z.infer<
  typeof DirectusAppointmentCreateInputSchema
>;
export type DirectusCreatedAppointment = {
  appointmentId: number;
  status: "pending";
};

export type DirectusAppointmentWriteClientConfig = {
  baseUrl: string;
  timeoutMs: number;
  fetchImplementation?: DirectusFetch;
};

export interface DirectusAppointmentWriteClient {
  createAppointment(
    accessToken: string,
    input: DirectusAppointmentCreateInput,
  ): Promise<DirectusCreatedAppointment>;
}

const createAppointmentUrl = (baseUrl: string) => {
  try {
    const url = new URL(baseUrl);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username.length > 0 ||
      url.password.length > 0
    ) {
      throw new Error("Invalid Directus URL.");
    }
    const basePath = url.pathname.replace(/\/+$/, "");
    url.pathname = `${basePath}/items/appointments`;
    url.search = new URLSearchParams([["fields", "id,status"]]).toString();
    url.hash = "";
    return url;
  } catch {
    throw new DirectusError("DIRECTUS_ERROR");
  }
};

export const createDirectusAppointmentWriteClient = (
  config: DirectusAppointmentWriteClientConfig,
): DirectusAppointmentWriteClient => {
  const appointmentUrl = createAppointmentUrl(config.baseUrl);
  const fetchImplementation = config.fetchImplementation ?? fetch;

  return {
    async createAppointment(accessToken, rawInput) {
      if (accessToken.trim().length === 0) {
        throw new DirectusError("DIRECTUS_UNAUTHORIZED");
      }
      const input = DirectusAppointmentCreateInputSchema.parse(rawInput);
      const abortController = new AbortController();
      const timeout = setTimeout(
        () => abortController.abort(),
        config.timeoutMs,
      );

      try {
        const response = await fetchImplementation(appointmentUrl, {
          method: "POST",
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(input),
          signal: abortController.signal,
        });
        if (!response.ok) {
          throw mapDirectusHttpStatus(response.status);
        }

        let payload: unknown;
        try {
          payload = (await response.json()) as unknown;
        } catch {
          throw new DirectusError("DIRECTUS_INVALID_RESPONSE");
        }
        const parsed = directusCreatedAppointmentResponseSchema.safeParse(
          payload,
        );
        if (!parsed.success) {
          throw new DirectusError("DIRECTUS_INVALID_RESPONSE");
        }
        return {
          appointmentId: parsed.data.data.id,
          status: parsed.data.data.status,
        };
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
    },
  };
};
