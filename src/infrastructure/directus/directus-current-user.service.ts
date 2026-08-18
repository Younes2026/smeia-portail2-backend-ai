import { z } from "zod";

import { DirectusError, mapDirectusHttpStatus } from "./directus-errors.js";
import type { DirectusFetch } from "./directus-http-client.js";

const directusCurrentUserResponseSchema = z
  .object({
    data: z
      .object({
        id: z.uuid(),
        role: z
          .object({
            id: z.uuid(),
            name: z.string().trim().min(1),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

export type DirectusCurrentUser = z.infer<
  typeof directusCurrentUserResponseSchema
>["data"];

export type DirectusCurrentUserServiceConfig = {
  baseUrl: string;
  timeoutMs: number;
  fetchImplementation?: DirectusFetch;
};

export interface DirectusCurrentUserService {
  getCurrentUser(accessToken: string): Promise<DirectusCurrentUser>;
}

const createCurrentUserUrl = (baseUrl: string) => {
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
    url.pathname = `${basePath}/users/me`;
    url.search = new URLSearchParams([
      ["fields", "id,role.id,role.name"],
    ]).toString();
    url.hash = "";
    return url;
  } catch {
    throw new DirectusError("DIRECTUS_ERROR");
  }
};

export const createDirectusCurrentUserService = (
  config: DirectusCurrentUserServiceConfig,
): DirectusCurrentUserService => {
  const currentUserUrl = createCurrentUserUrl(config.baseUrl);
  const fetchImplementation = config.fetchImplementation ?? fetch;

  return {
    async getCurrentUser(accessToken) {
      if (accessToken.trim().length === 0) {
        throw new DirectusError("DIRECTUS_UNAUTHORIZED");
      }

      const abortController = new AbortController();
      const timeout = setTimeout(
        () => abortController.abort(),
        config.timeoutMs,
      );

      try {
        const response = await fetchImplementation(currentUserUrl, {
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

        let payload: unknown;
        try {
          payload = (await response.json()) as unknown;
        } catch {
          throw new DirectusError("DIRECTUS_INVALID_RESPONSE");
        }

        const parsed = directusCurrentUserResponseSchema.safeParse(payload);
        if (!parsed.success) {
          throw new DirectusError("DIRECTUS_INVALID_RESPONSE");
        }
        return parsed.data.data;
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
