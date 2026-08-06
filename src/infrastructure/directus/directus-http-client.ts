import {
  DirectusError,
  mapDirectusHttpStatus,
} from "./directus-errors.js";

export type DirectusFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type DirectusHttpClientConfig = {
  baseUrl: string;
  timeoutMs: number;
  fetchImplementation?: DirectusFetch;
};

export interface DirectusReadClient {
  getJson(
    endpoint: string,
    searchParams: URLSearchParams,
    accessToken: string,
  ): Promise<unknown>;
}

const parseBaseUrl = (value: string) => {
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username.length > 0 ||
      url.password.length > 0
    ) {
      throw new Error("Invalid Directus base URL.");
    }

    url.search = "";
    url.hash = "";
    return url;
  } catch {
    throw new DirectusError("DIRECTUS_ERROR");
  }
};

const buildReadUrl = (
  baseUrl: URL,
  endpoint: string,
  searchParams: URLSearchParams,
) => {
  if (!endpoint.startsWith("/items/") || endpoint.includes("?") || endpoint.includes("#")) {
    throw new DirectusError("DIRECTUS_ERROR");
  }

  const url = new URL(baseUrl);
  const basePath = url.pathname.replace(/\/+$/, "");
  const endpointPath = endpoint.replace(/^\/+/, "");
  url.pathname = `${basePath}/${endpointPath}`;
  url.search = searchParams.toString();
  return url;
};

export const createDirectusHttpClient = (
  config: DirectusHttpClientConfig,
): DirectusReadClient => {
  const baseUrl = parseBaseUrl(config.baseUrl);
  const fetchImplementation = config.fetchImplementation ?? fetch;

  return {
    async getJson(endpoint, searchParams, accessToken) {
      if (accessToken.trim().length === 0) {
        throw new DirectusError("DIRECTUS_UNAUTHORIZED");
      }

      const url = buildReadUrl(baseUrl, endpoint, searchParams);
      const abortController = new AbortController();
      const timeout = setTimeout(() => abortController.abort(), config.timeoutMs);

      try {
        const response = await fetchImplementation(url, {
          method: "GET",
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${accessToken}`,
          },
          signal: abortController.signal,
        });

        if (!response.ok) {
          throw mapDirectusHttpStatus(response.status);
        }

        try {
          return (await response.json()) as unknown;
        } catch {
          throw new DirectusError("DIRECTUS_INVALID_RESPONSE");
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
    },
  };
};
