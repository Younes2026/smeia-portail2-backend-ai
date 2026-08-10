import type { Server } from "node:http";

import { z } from "zod";

process.env.DOTENV_CONFIG_QUIET = "true";
process.env.OPENAI_MAX_RETRIES = "0";

const originalFetch: typeof fetch = globalThis.fetch.bind(globalThis);
const directusGetPaths: string[] = [];
let directusOrigin = "";
let directusItemsPathPrefix = "";
let localServerOrigin = "";
let localPostCount = 0;
let openAiCallCount = 0;
let httpStatus: number | null = null;

const monitoredFetch: typeof fetch = async (input, init) => {
  const rawUrl =
    input instanceof Request
      ? input.url
      : input instanceof URL
        ? input.href
        : input;
  const url = new URL(rawUrl);
  const method = (
    init?.method ?? (input instanceof Request ? input.method : "GET")
  ).toUpperCase();

  if (url.hostname === "api.openai.com" || url.hostname.endsWith(".openai.com")) {
    openAiCallCount += 1;
    throw new Error("LIVE_TEST_OPENAI_FORBIDDEN");
  }

  if (localServerOrigin.length > 0 && url.origin === localServerOrigin) {
    if (
      method !== "POST" ||
      url.pathname !== "/api/ai/appointments/availability" ||
      url.search.length > 0 ||
      localPostCount !== 0
    ) {
      throw new Error("LIVE_TEST_LOCAL_REQUEST_FORBIDDEN");
    }

    localPostCount += 1;
    return originalFetch(input, init);
  }

  if (directusOrigin.length > 0 && url.origin === directusOrigin) {
    if (
      method !== "GET" ||
      !url.pathname.startsWith(directusItemsPathPrefix) ||
      url.pathname.includes("/auth/login")
    ) {
      throw new Error("LIVE_TEST_DIRECTUS_METHOD_FORBIDDEN");
    }

    directusGetPaths.push(url.pathname);
    return originalFetch(input, init);
  }

  throw new Error("LIVE_TEST_NETWORK_TARGET_FORBIDDEN");
};

globalThis.fetch = monitoredFetch;

const [{ createApp }, { env }, { IsoDateSchema, IsoTimeSchema }] =
  await Promise.all([
    import("../src/app.js"),
    import("../src/config/env.js"),
    import("../src/domain/ai-booking/index.js"),
  ]);

const directusUrl = new URL(env.DIRECTUS_URL);
directusOrigin = directusUrl.origin;
const directusBasePath = directusUrl.pathname.replace(/\/+$/, "");
directusItemsPathPrefix = `${directusBasePath}/items/`;

const showroomSchema = z
  .object({
    id: z.literal(1),
    name: z.literal("Moulay Slimane"),
    address: z.string().trim().min(1).nullable(),
    city: z.string().trim().min(1).nullable(),
    phone: z.string().trim().min(1).nullable(),
  })
  .strict();

const optionSchema = z
  .object({
    workshop_id: z.union([z.literal(1), z.literal(2)]),
    workshop_name: z.string().trim().min(1),
    showroom: showroomSchema,
    requested_date: IsoDateSchema,
    requested_time: IsoTimeSchema,
    slot_interval_minutes: z.literal(30),
    label: z.string().trim().min(1),
  })
  .strict();

const responseSchema = z
  .object({
    data: z
      .object({
        preferred_date_available: z.boolean(),
        options: z.array(optionSchema).max(3),
      })
      .strict(),
  })
  .strict();

const errorResponseSchema = z
  .object({
    error: z
      .object({
        code: z.string().trim().min(1).max(100),
        message: z.string(),
      })
      .strict(),
  })
  .strict();

const requestBody = {
  service_type_id: 2,
  workshop_ids: [1, 2],
  preferred_date: "2026-08-11",
  preferred_period: "morning",
} as const;

const forbiddenPublicKeys = new Set([
  "appointments",
  "authorization",
  "capacity",
  "customer_id",
  "daily_hours",
  "registration_number",
  "remaining_capacity_hours",
  "resources",
  "status",
  "token",
  "total_capacity_hours",
  "used_capacity_hours",
  "vehicle_id",
  "vin",
]);

const containsForbiddenPublicKey = (value: unknown): boolean => {
  if (Array.isArray(value)) {
    return value.some(containsForbiddenPublicKey);
  }

  if (typeof value !== "object" || value === null) {
    return false;
  }

  return Object.entries(value).some(
    ([key, nestedValue]) =>
      forbiddenPublicKeys.has(key.toLowerCase()) ||
      containsForbiddenPublicKey(nestedValue),
  );
};

const closeServer = async (server: Server) => {
  if (!server.listening) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) {
        resolve();
        return;
      }

      reject(error);
    });
  });
};

const listenOnEphemeralPort = async (server: Server) => {
  if (server.listening) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    const onError = () => {
      server.off("listening", onListening);
      reject(new Error("LIVE_TEST_SERVER_ERROR"));
    };

    server.once("listening", onListening);
    server.once("error", onError);
  });
};

const readJson = async (response: Response): Promise<unknown> => {
  try {
    return (await response.json()) as unknown;
  } catch {
    throw new Error("LIVE_TEST_INVALID_JSON_RESPONSE");
  }
};

const getNetworkSummary = () => ({
  local_post_count: localPostCount,
  directus_get_count: directusGetPaths.length,
  directus_get_paths: directusGetPaths,
  openai_call_count: openAiCallCount,
});

const main = async () => {
  const clientToken = process.env.DIRECTUS_TEST_TOKEN?.trim();
  if (clientToken === undefined || clientToken.length === 0) {
    throw new Error("DIRECTUS_TEST_TOKEN_MISSING");
  }
  if (env.DIRECTUS_BOOKING_TOKEN === undefined) {
    throw new Error("DIRECTUS_BOOKING_TOKEN_MISSING");
  }

  const application = createApp();
  const server = application.listen(0, "127.0.0.1");

  try {
    await listenOnEphemeralPort(server);
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("LIVE_TEST_SERVER_ERROR");
    }
    localServerOrigin = `http://127.0.0.1:${address.port}`;

    const response = await fetch(
      `${localServerOrigin}/api/ai/appointments/availability`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${clientToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
      },
    );
    httpStatus = response.status;

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("application/json")) {
      throw new Error("LIVE_TEST_INVALID_CONTENT_TYPE");
    }

    const payload = await readJson(response);
    if (response.status !== 200) {
      const parsedError = errorResponseSchema.safeParse(payload);
      throw new Error(
        parsedError.success
          ? parsedError.data.error.code
          : "LIVE_TEST_HTTP_ERROR",
      );
    }

    const parsedResponse = responseSchema.safeParse(payload);
    if (
      !parsedResponse.success ||
      containsForbiddenPublicKey(parsedResponse.data) ||
      JSON.stringify(parsedResponse.data).includes(clientToken) ||
      localPostCount !== 1 ||
      openAiCallCount !== 0 ||
      directusGetPaths.length === 0
    ) {
      throw new Error("LIVE_TEST_UNSAFE_AVAILABILITY_RESPONSE");
    }

    console.log(
      JSON.stringify(
        {
          http_status: response.status,
          preferred_date_available:
            parsedResponse.data.data.preferred_date_available,
          options: parsedResponse.data.data.options,
          network: getNetworkSummary(),
        },
        null,
        2,
      ),
    );
  } finally {
    await closeServer(server);
  }
};

try {
  await main();
} catch (error: unknown) {
  const errorCode =
    error instanceof Error && /^[A-Z][A-Z0-9_]{0,99}$/.test(error.message)
      ? error.message
      : "LIVE_TEST_ERROR";

  console.error(
    JSON.stringify({
      http_status: httpStatus,
      error_code: errorCode,
      network: getNetworkSummary(),
    }),
  );
  process.exitCode = 1;
} finally {
  globalThis.fetch = originalFetch;
}
