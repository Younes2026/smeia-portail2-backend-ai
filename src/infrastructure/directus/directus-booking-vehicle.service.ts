import { z } from "zod";

import { BookingVehicleIdSchema } from "../../domain/ai-booking/index.js";
import { DirectusError } from "./directus-errors.js";
import type { DirectusReadClient } from "./directus-http-client.js";

const directusRelationIdSchema = z
  .union([
    z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    z
      .object({
        id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      })
      .strict(),
  ])
  .transform((relation) =>
    typeof relation === "number" ? relation : relation.id,
  );

const directusBookingVehicleSchema = z
  .object({
    id: BookingVehicleIdSchema,
    customer_id: directusRelationIdSchema,
    brand_id: z
      .object({ name: z.string().trim().min(1).max(100) })
      .strict(),
    model: z.string().trim().min(1).max(100).nullable(),
  })
  .strict();

const directusBookingVehicleResponseSchema = z
  .object({ data: directusBookingVehicleSchema })
  .strict();

const bookingVehicleIdentitySchema = z
  .object({
    vehicleId: BookingVehicleIdSchema,
    customerId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    label: z.string().trim().min(1).max(201),
  })
  .strict();

export type DirectusBookingVehicleIdentity = z.infer<
  typeof bookingVehicleIdentitySchema
>;

export interface DirectusBookingVehicleService {
  getBookingVehicleIdentity(
    accessToken: string,
    vehicleId: unknown,
  ): Promise<DirectusBookingVehicleIdentity>;
}

const vehicleFields = new URLSearchParams([
  ["fields", "id,customer_id,brand_id.name,model"],
]);

const mapVehicleAccessError = (error: unknown): never => {
  if (
    error instanceof DirectusError &&
    (error.code === "DIRECTUS_FORBIDDEN" ||
      error.code === "DIRECTUS_NOT_FOUND")
  ) {
    throw new DirectusError("DIRECTUS_VEHICLE_NOT_ACCESSIBLE");
  }
  throw error;
};

export const createDirectusBookingVehicleService = (
  client: DirectusReadClient,
): DirectusBookingVehicleService => ({
  async getBookingVehicleIdentity(accessToken, rawVehicleId) {
    const parsedVehicleId = BookingVehicleIdSchema.safeParse(rawVehicleId);
    if (!parsedVehicleId.success) {
      throw new DirectusError("DIRECTUS_INVALID_VEHICLE_ID");
    }

    try {
      const payload = await client.getJson(
        `/items/vehicles/${parsedVehicleId.data}`,
        new URLSearchParams(vehicleFields),
        accessToken,
      );
      const parsed = directusBookingVehicleResponseSchema.safeParse(payload);
      if (!parsed.success || parsed.data.data.id !== parsedVehicleId.data) {
        throw new DirectusError("DIRECTUS_INVALID_RESPONSE");
      }

      const vehicle = parsed.data.data;
      const normalizedModel = vehicle.model?.trim();
      const label =
        normalizedModel === undefined ||
        normalizedModel.toLowerCase() === "unknown"
          ? vehicle.brand_id.name
          : `${vehicle.brand_id.name} ${normalizedModel}`;
      return bookingVehicleIdentitySchema.parse({
        vehicleId: vehicle.id,
        customerId: vehicle.customer_id,
        label,
      });
    } catch (error: unknown) {
      return mapVehicleAccessError(error);
    }
  },
});
