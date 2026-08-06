import { z } from "zod";

import {
  ALLOWED_SERVICE_TYPE_IDS,
  ALLOWED_WORKSHOP_IDS,
} from "../../domain/ai-diagnostic/index.js";
import { DirectusError } from "./directus-errors.js";
import type { DirectusReadClient } from "./directus-http-client.js";

const directusServiceSchema = z
  .object({
    id: z.literal(ALLOWED_SERVICE_TYPE_IDS),
    name: z.string().trim().min(1),
    code: z.string().trim().min(1),
  })
  .strict();

const directusWorkshopSchema = z
  .object({
    id: z.literal(ALLOWED_WORKSHOP_IDS),
    name: z.string().trim().min(1),
    workshop_type: z.string().trim().min(1),
    active: z.literal(true),
    client_bookable: z.literal(true),
  })
  .strict();

const directusServicesResponseSchema = z
  .object({
    data: z.array(directusServiceSchema),
  })
  .strict();

const directusWorkshopsResponseSchema = z
  .object({
    data: z.array(directusWorkshopSchema),
  })
  .strict();

export type AvailableService = z.infer<typeof directusServiceSchema>;
export type AvailableWorkshop = Pick<
  z.infer<typeof directusWorkshopSchema>,
  "id" | "name" | "workshop_type"
>;

export type DirectusAiCatalogs = {
  available_services: AvailableService[];
  available_workshops: AvailableWorkshop[];
};

export interface DirectusCatalogService {
  getAvailableServices(
    accessToken: string,
  ): Promise<{ available_services: AvailableService[] }>;
  getAvailableWorkshops(
    accessToken: string,
  ): Promise<{ available_workshops: AvailableWorkshop[] }>;
  getAiCatalogs(accessToken: string): Promise<DirectusAiCatalogs>;
}

const serviceQuery = new URLSearchParams([
  ["fields", "id,name,code"],
  ["filter[id][_in]", ALLOWED_SERVICE_TYPE_IDS.join(",")],
  ["sort", "id"],
  ["limit", String(ALLOWED_SERVICE_TYPE_IDS.length)],
]);

const workshopQuery = new URLSearchParams([
  ["fields", "id,name,workshop_type,active,client_bookable"],
  ["filter[id][_in]", ALLOWED_WORKSHOP_IDS.join(",")],
  ["filter[active][_eq]", "true"],
  ["filter[client_bookable][_eq]", "true"],
  ["sort", "id"],
  ["limit", String(ALLOWED_WORKSHOP_IDS.length)],
]);

const hasExactlyExpectedIds = (
  actualIds: readonly number[],
  expectedIds: readonly number[],
) => {
  const uniqueIds = new Set(actualIds);
  return (
    actualIds.length === expectedIds.length &&
    uniqueIds.size === expectedIds.length &&
    expectedIds.every((id) => uniqueIds.has(id))
  );
};

const parseServices = (payload: unknown): AvailableService[] => {
  const parsed = directusServicesResponseSchema.safeParse(payload);
  if (
    !parsed.success ||
    !hasExactlyExpectedIds(
      parsed.data.data.map((service) => service.id),
      ALLOWED_SERVICE_TYPE_IDS,
    )
  ) {
    throw new DirectusError("DIRECTUS_INVALID_RESPONSE");
  }

  return [...parsed.data.data].sort((left, right) => left.id - right.id);
};

const parseWorkshops = (payload: unknown): AvailableWorkshop[] => {
  const parsed = directusWorkshopsResponseSchema.safeParse(payload);
  if (
    !parsed.success ||
    !hasExactlyExpectedIds(
      parsed.data.data.map((workshop) => workshop.id),
      ALLOWED_WORKSHOP_IDS,
    )
  ) {
    throw new DirectusError("DIRECTUS_INVALID_RESPONSE");
  }

  return [...parsed.data.data]
    .sort((left, right) => left.id - right.id)
    .map(({ id, name, workshop_type }) => ({ id, name, workshop_type }));
};

export const createDirectusCatalogService = (
  client: DirectusReadClient,
): DirectusCatalogService => {
  const getAvailableServices = async (accessToken: string) => {
    const payload = await client.getJson(
      "/items/service_types",
      new URLSearchParams(serviceQuery),
      accessToken,
    );
    return { available_services: parseServices(payload) };
  };

  const getAvailableWorkshops = async (accessToken: string) => {
    const payload = await client.getJson(
      "/items/workshops",
      new URLSearchParams(workshopQuery),
      accessToken,
    );
    return { available_workshops: parseWorkshops(payload) };
  };

  return {
    getAvailableServices,
    getAvailableWorkshops,
    async getAiCatalogs(accessToken) {
      const [services, workshops] = await Promise.all([
        getAvailableServices(accessToken),
        getAvailableWorkshops(accessToken),
      ]);

      return {
        available_services: services.available_services,
        available_workshops: workshops.available_workshops,
      };
    },
  };
};
