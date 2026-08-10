import { randomUUID } from "node:crypto";
import type { Server } from "node:http";

import { z } from "zod";

process.env.DOTENV_CONFIG_QUIET = "true";
process.env.OPENAI_MAX_RETRIES = "0";

const AVAILABILITY_PATH = "/api/ai/appointments/availability";
const CONFIRMATION_PATH = "/api/ai/appointments/confirm";
const PROBLEM_SUMMARY =
  "Test intégration assistant IA - demande de diagnostic.";

const originalFetch: typeof fetch = globalThis.fetch.bind(globalThis);
let directusOrigin = "";
let directusAppointmentsPath = "";
let localServerOrigin = "";
let localAvailabilityPostCount = 0;
let localConfirmationPostCount = 0;
let directusAppointmentPostCount = 0;
let openAiCallCount = 0;
const directusGetPaths: string[] = [];
const allowedDirectusGetPaths = new Set<string>();

const getRequestUrl = (input: string | URL | Request) =>
  new URL(
    input instanceof Request
      ? input.url
      : input instanceof URL
        ? input.href
        : input,
  );

const getRequestMethod = (
  input: string | URL | Request,
  init?: RequestInit,
) =>
  (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();

const hasSensitiveQueryParameter = (url: URL) =>
  [...url.searchParams.keys()].some((key) =>
    ["access_token", "authorization", "token"].includes(key.toLowerCase()),
  );

const monitoredFetch: typeof fetch = async (input, init) => {
  const url = getRequestUrl(input);
  const method = getRequestMethod(input, init);

  if (url.hostname === "api.openai.com" || url.hostname.endsWith(".openai.com")) {
    openAiCallCount += 1;
    throw new Error("LIVE_TEST_OPENAI_FORBIDDEN");
  }

  if (localServerOrigin.length > 0 && url.origin === localServerOrigin) {
    if (method !== "POST" || url.search.length > 0) {
      throw new Error("LIVE_TEST_LOCAL_REQUEST_FORBIDDEN");
    }

    if (
      url.pathname === AVAILABILITY_PATH &&
      localAvailabilityPostCount === 0 &&
      localConfirmationPostCount === 0
    ) {
      localAvailabilityPostCount += 1;
      return originalFetch(input, init);
    }

    if (
      url.pathname === CONFIRMATION_PATH &&
      localAvailabilityPostCount === 1 &&
      localConfirmationPostCount === 0
    ) {
      localConfirmationPostCount += 1;
      return originalFetch(input, init);
    }

    throw new Error("LIVE_TEST_LOCAL_REQUEST_FORBIDDEN");
  }

  if (directusOrigin.length > 0 && url.origin === directusOrigin) {
    if (
      url.pathname.includes("/auth/login") ||
      hasSensitiveQueryParameter(url)
    ) {
      throw new Error("LIVE_TEST_DIRECTUS_REQUEST_FORBIDDEN");
    }

    if (method === "GET" && allowedDirectusGetPaths.has(url.pathname)) {
      if (
        localAvailabilityPostCount !== 1 ||
        localConfirmationPostCount > 1
      ) {
        throw new Error("LIVE_TEST_DIRECTUS_REQUEST_FORBIDDEN");
      }
      directusGetPaths.push(url.pathname);
      return originalFetch(input, init);
    }

    if (
      method === "POST" &&
      url.pathname === directusAppointmentsPath &&
      url.searchParams.size === 1 &&
      url.searchParams.get("fields") === "id,status" &&
      localAvailabilityPostCount === 1 &&
      localConfirmationPostCount === 1 &&
      directusAppointmentPostCount === 0
    ) {
      directusAppointmentPostCount += 1;
      return originalFetch(input, init);
    }

    throw new Error("LIVE_TEST_DIRECTUS_REQUEST_FORBIDDEN");
  }

  throw new Error("LIVE_TEST_NETWORK_TARGET_FORBIDDEN");
};

globalThis.fetch = monitoredFetch;

const [
  { createApp },
  { env },
  {
    AppointmentConfirmationResultSchema,
    SecuredAppointmentAvailabilityResultSchema,
  },
] = await Promise.all([
  import("../src/app.js"),
  import("../src/config/env.js"),
  import("../src/domain/ai-booking/index.js"),
]);

const directusUrl = new URL(env.DIRECTUS_URL);
directusOrigin = directusUrl.origin;
const directusBasePath = directusUrl.pathname.replace(/\/+$/, "");
directusAppointmentsPath = `${directusBasePath}/items/appointments`;
for (const path of [
  `${directusBasePath}/items/vehicles/14`,
  `${directusBasePath}/items/service_types`,
  `${directusBasePath}/items/workshops`,
  `${directusBasePath}/items/schedules`,
  `${directusBasePath}/items/resources`,
  directusAppointmentsPath,
]) {
  allowedDirectusGetPaths.add(path);
}

const availabilityResponseSchema = z
  .object({ data: SecuredAppointmentAvailabilityResultSchema })
  .strict();

const confirmationResponseSchema = z
  .object({ data: AppointmentConfirmationResultSchema })
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

const availabilityRequestBody = {
  vehicle_id: 14,
  service_type_id: 2,
  workshop_ids: [1, 2],
  preferred_date: "2026-08-13",
  preferred_period: "morning",
} as const;

const forbiddenConfirmationKeys = new Set([
  "appointments",
  "authorization",
  "capacity",
  "customer_id",
  "daily_hours",
  "headers",
  "idempotency-key",
  "registration_number",
  "remaining_capacity_hours",
  "resources",
  "slot_token",
  "token",
  "total_capacity_hours",
  "used_capacity_hours",
  "vin",
]);

const containsForbiddenConfirmationKey = (value: unknown): boolean => {
  if (Array.isArray(value)) {
    return value.some(containsForbiddenConfirmationKey);
  }
  if (typeof value !== "object" || value === null) {
    return false;
  }
  return Object.entries(value).some(
    ([key, nestedValue]) =>
      forbiddenConfirmationKeys.has(key.toLowerCase()) ||
      containsForbiddenConfirmationKey(nestedValue),
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

const waitForServer = async (server: Server) => {
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

const readSuccessfulJson = async (
  response: Response,
  expectedStatus: number,
): Promise<unknown> => {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new Error("LIVE_TEST_INVALID_CONTENT_TYPE");
  }
  const payload = await readJson(response);
  if (response.status !== expectedStatus) {
    const parsedError = errorResponseSchema.safeParse(payload);
    throw new Error(
      parsedError.success ? parsedError.data.error.code : "LIVE_TEST_HTTP_ERROR",
    );
  }
  return payload;
};

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

  const application = createApp();
  const server = application.listen(0, "127.0.0.1");

  try {
    await waitForServer(server);
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("LIVE_TEST_SERVER_ERROR");
    }
    localServerOrigin = `http://127.0.0.1:${address.port}`;

    const availabilityResponse = await fetch(
      `${localServerOrigin}${AVAILABILITY_PATH}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${clientToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(availabilityRequestBody),
      },
    );
    const availabilityPayload = await readSuccessfulJson(
      availabilityResponse,
      200,
    );
    const parsedAvailability = availabilityResponseSchema.safeParse(
      availabilityPayload,
    );
    if (!parsedAvailability.success) {
      throw new Error("LIVE_TEST_INVALID_AVAILABILITY_RESPONSE");
    }

    const firstOption = parsedAvailability.data.data.options[0];
    if (firstOption === undefined) {
      if (directusAppointmentPostCount !== 0) {
        throw new Error("LIVE_TEST_UNEXPECTED_APPOINTMENT_WRITE");
      }
      throw new Error("LIVE_TEST_NO_AVAILABILITY_OPTION");
    }
    if (
      firstOption.service_type.id !== 2 ||
      firstOption.service_type.name !== "Diagnostic" ||
      (firstOption.workshop_id !== 1 && firstOption.workshop_id !== 2) ||
      firstOption.showroom.id !== 1 ||
      firstOption.showroom.name !== "Moulay Slimane"
    ) {
      throw new Error("LIVE_TEST_INVALID_AVAILABILITY_OPTION");
    }

    const idempotencyKey = randomUUID();
    const confirmationResponse = await fetch(
      `${localServerOrigin}${CONFIRMATION_PATH}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${clientToken}`,
          "Idempotency-Key": idempotencyKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          slot_token: firstOption.slot_token,
          problem_summary: PROBLEM_SUMMARY,
          confirmation: true,
        }),
      },
    );
    const confirmationPayload = await readSuccessfulJson(
      confirmationResponse,
      201,
    );
    const parsedConfirmation = confirmationResponseSchema.safeParse(
      confirmationPayload,
    );
    if (!parsedConfirmation.success) {
      throw new Error("LIVE_TEST_INVALID_CONFIRMATION_RESPONSE");
    }

    const confirmation = parsedConfirmation.data.data;
    if (
      confirmation.appointment_id <= 0 ||
      confirmation.status !== "pending" ||
      confirmation.vehicle.id !== 14 ||
      confirmation.service_type.id !== 2 ||
      confirmation.service_type.name !== "Diagnostic" ||
      (confirmation.workshop.id !== 1 && confirmation.workshop.id !== 2) ||
      confirmation.workshop.id !== firstOption.workshop_id ||
      confirmation.showroom.id !== 1 ||
      confirmation.showroom.name !== "Moulay Slimane" ||
      confirmation.requested_date !== firstOption.requested_date ||
      confirmation.requested_time !== firstOption.requested_time ||
      confirmation.problem_summary !== PROBLEM_SUMMARY ||
      containsForbiddenConfirmationKey(confirmation) ||
      localAvailabilityPostCount !== 1 ||
      localConfirmationPostCount !== 1 ||
      directusAppointmentPostCount !== 1 ||
      directusGetPaths.length === 0 ||
      openAiCallCount !== 0
    ) {
      throw new Error("LIVE_TEST_UNSAFE_CONFIRMATION_RESPONSE");
    }

    const serializedConfirmation = JSON.stringify(confirmation);
    if (
      serializedConfirmation.includes(clientToken) ||
      serializedConfirmation.includes(idempotencyKey) ||
      serializedConfirmation.includes(firstOption.slot_token) ||
      serializedConfirmation.includes(env.DIRECTUS_BOOKING_TOKEN) ||
      serializedConfirmation.includes(env.AI_BOOKING_SLOT_SECRET)
    ) {
      throw new Error("LIVE_TEST_SECRET_EXPOSURE");
    }

    console.log(JSON.stringify(confirmation, null, 2));
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
  console.error(JSON.stringify({ error_code: errorCode }));
  process.exitCode = 1;
} finally {
  globalThis.fetch = originalFetch;
}
