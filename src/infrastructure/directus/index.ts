import { env } from "../../config/env.js";
import { createDirectusCatalogService } from "./directus-catalog.service.js";
import { createDirectusHttpClient } from "./directus-http-client.js";

const configuredCatalogService = createDirectusCatalogService(
  createDirectusHttpClient({
    baseUrl: env.DIRECTUS_URL,
    timeoutMs: env.DIRECTUS_TIMEOUT_MS,
  }),
);

export const getDirectusAiCatalogs = (accessToken: string) =>
  configuredCatalogService.getAiCatalogs(accessToken);

export {
  createDirectusCatalogService,
  type AvailableService,
  type AvailableWorkshop,
  type DirectusAiCatalogs,
  type DirectusCatalogService,
} from "./directus-catalog.service.js";
export {
  DirectusError,
  mapDirectusHttpStatus,
  type DirectusErrorCode,
} from "./directus-errors.js";
export {
  createDirectusHttpClient,
  type DirectusFetch,
  type DirectusHttpClientConfig,
  type DirectusReadClient,
} from "./directus-http-client.js";
