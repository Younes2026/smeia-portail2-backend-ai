import { z } from "zod";

import { DirectusError } from "./directus-errors.js";
import type { DirectusReadClient } from "./directus-http-client.js";

const MAX_MODEL_LENGTH = 100;
const MAX_BRAND_NAME_LENGTH = 100;
const MAX_MILEAGE = 10_000_000;

const vehicleIdSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);

const directusVehicleSchema = z
  .object({
    id: vehicleIdSchema,
    brand_id: z
      .object({
        id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        name: z.string().trim().min(1).max(MAX_BRAND_NAME_LENGTH),
      })
      .strict(),
    model: z.string().trim().min(1).max(MAX_MODEL_LENGTH).nullable(),
    year: z
      .number()
      .int()
      .min(1886)
      .max(new Date().getFullYear() + 1)
      .nullable(),
    mileage: z.number().int().min(0).max(MAX_MILEAGE).nullable(),
  })
  .strict();

const directusVehicleResponseSchema = z
  .object({
    data: directusVehicleSchema,
  })
  .strict();

const vehicleContextSchema = z
  .object({
    vehicle_id: vehicleIdSchema,
    brand: z.string().trim().min(1).max(MAX_BRAND_NAME_LENGTH),
    model: z.string().trim().min(1).max(MAX_MODEL_LENGTH).nullable(),
    year: z.number().int().nullable(),
    mileage: z.number().int().min(0).max(MAX_MILEAGE).nullable(),
  })
  .strict();

export type DirectusVehicleContext = z.infer<typeof vehicleContextSchema>;

export interface DirectusVehicleContextService {
  getVehicleContext(
    accessToken: string,
    vehicleId: unknown,
  ): Promise<DirectusVehicleContext>;
}

const vehicleFields = new URLSearchParams([
  ["fields", "id,brand_id.id,brand_id.name,model,year,mileage"],
]);

const parseVehicleId = (vehicleId: unknown) => {
  const parsed = vehicleIdSchema.safeParse(vehicleId);
  if (!parsed.success) {
    throw new DirectusError("DIRECTUS_INVALID_VEHICLE_ID");
  }

  return parsed.data;
};

const parseVehicleContext = (
  payload: unknown,
  requestedVehicleId: number,
): DirectusVehicleContext => {
  const parsed = directusVehicleResponseSchema.safeParse(payload);
  if (!parsed.success || parsed.data.data.id !== requestedVehicleId) {
    throw new DirectusError("DIRECTUS_INVALID_RESPONSE");
  }

  const { id, brand_id, model, year, mileage } = parsed.data.data;
  return vehicleContextSchema.parse({
    vehicle_id: id,
    brand: brand_id.name,
    model,
    year,
    mileage,
  });
};

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

export const createDirectusVehicleContextService = (
  client: DirectusReadClient,
): DirectusVehicleContextService => ({
  async getVehicleContext(accessToken, vehicleId) {
    const validatedVehicleId = parseVehicleId(vehicleId);

    try {
      const payload = await client.getJson(
        `/items/vehicles/${validatedVehicleId}`,
        new URLSearchParams(vehicleFields),
        accessToken,
      );
      return parseVehicleContext(payload, validatedVehicleId);
    } catch (error: unknown) {
      return mapVehicleAccessError(error);
    }
  },
});
