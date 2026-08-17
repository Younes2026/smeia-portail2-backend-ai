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
      localPostCount >= 2
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

const [
  { createApp },
  { env },
  { SecuredAppointmentAvailabilityResultSchema },
  { BOOKING_SLOT_TOKEN_VERSION, createBookingSlotTokenService },
] =
  await Promise.all([
    import("../src/app.js"),
    import("../src/config/env.js"),
    import("../src/domain/ai-booking/index.js"),
    import("../src/application/ai-booking/index.js"),
  ]);

const directusUrl = new URL(env.DIRECTUS_URL);
directusOrigin = directusUrl.origin;
const directusBasePath = directusUrl.pathname.replace(/\/+$/, "");
directusItemsPathPrefix = `${directusBasePath}/items/`;

const responseSchema = z
  .object({
    data: SecuredAppointmentAvailabilityResultSchema,
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

const scenarios = [
  {
    name: "Oujda",
    request: {
      vehicle_id: 14,
      showroom_id: 8,
      service_type_id: 2,
      workshop_types: ["mecanique"],
      preferred_date: "2026-08-18",
      preferred_period: "any",
    },
    expectedWorkshopId: 20,
  },
  {
    name: "Tanger",
    request: {
      vehicle_id: 14,
      showroom_id: 5,
      service_type_id: 4,
      workshop_types: ["carrosserie"],
      preferred_date: "2026-08-18",
      preferred_period: "any",
    },
    expectedWorkshopId: 24,
  },
] as const;

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
  "workshop_ids",
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
  if (env.AI_BOOKING_SLOT_SECRET === undefined) {
    throw new Error("AI_BOOKING_SLOT_SECRET_MISSING");
  }

  const slotTokenService = createBookingSlotTokenService({
    secret: env.AI_BOOKING_SLOT_SECRET,
    now: () => new Date(),
  });

  const application = createApp();
  const server = application.listen(0, "127.0.0.1");

  try {
    await listenOnEphemeralPort(server);
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("LIVE_TEST_SERVER_ERROR");
    }
    localServerOrigin = `http://127.0.0.1:${address.port}`;

    const results = [];
    for (const scenario of scenarios) {
      if (Object.hasOwn(scenario.request, "workshop_ids")) {
        throw new Error("LIVE_TEST_LEGACY_WORKSHOP_IDS");
      }

      const response = await fetch(
        `${localServerOrigin}/api/ai/appointments/availability`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${clientToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(scenario.request),
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
      if (!parsedResponse.success) {
        throw new Error("LIVE_TEST_INVALID_AVAILABILITY_RESPONSE");
      }
      const serializedResponse = JSON.stringify(parsedResponse.data);
      if (
        containsForbiddenPublicKey(parsedResponse.data) ||
        serializedResponse.includes(clientToken) ||
        serializedResponse.includes(env.DIRECTUS_BOOKING_TOKEN) ||
        serializedResponse.includes(env.AI_BOOKING_SLOT_SECRET) ||
        openAiCallCount !== 0
      ) {
        throw new Error("LIVE_TEST_UNSAFE_AVAILABILITY_RESPONSE");
      }

      const firstOption = parsedResponse.data.data.options[0];
      if (
        firstOption === undefined ||
        parsedResponse.data.data.options.some(
          (option) =>
            option.service_type.id !== scenario.request.service_type_id ||
            option.workshop_id !== scenario.expectedWorkshopId ||
            option.showroom.id !== scenario.request.showroom_id,
        )
      ) {
        throw new Error("LIVE_TEST_INVALID_AVAILABILITY_OPTION");
      }

      const token = slotTokenService.verify(firstOption.slot_token);
      if (
        token.version !== BOOKING_SLOT_TOKEN_VERSION ||
        token.service_type_id !== scenario.request.service_type_id ||
        token.workshop_id !== scenario.expectedWorkshopId ||
        token.showroom_id !== scenario.request.showroom_id ||
        token.requested_date !== firstOption.requested_date ||
        token.requested_time !== firstOption.requested_time
      ) {
        throw new Error("LIVE_TEST_INVALID_SLOT_TOKEN");
      }

      results.push({
        scenario: scenario.name,
        showroom_id: firstOption.showroom.id,
        workshop_id: firstOption.workshop_id,
        workshop_name: firstOption.workshop_name,
        requested_date: firstOption.requested_date,
        requested_time: firstOption.requested_time,
        token_version: token.version,
      });
    }

    if (
      localPostCount !== scenarios.length ||
      directusGetPaths.length === 0 ||
      openAiCallCount !== 0
    ) {
      throw new Error("LIVE_TEST_UNEXPECTED_NETWORK_CALLS");
    }

    console.log(
      JSON.stringify(
        {
          scenarios: results,
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
