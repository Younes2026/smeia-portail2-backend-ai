import type { Server } from "node:http";

import { z } from "zod";

process.env.DOTENV_CONFIG_QUIET = "true";
process.env.OPENAI_MAX_RETRIES = "0";

const [
  { createApp },
  {
    ALLOWED_SERVICE_TYPE_IDS,
    ALLOWED_WORKSHOP_TYPES,
    AiDiagnosticModelOutputSchema,
  },
] = await Promise.all([
  import("../src/app.js"),
  import("../src/domain/ai-diagnostic/index.js"),
]);

const responseSchema = z
  .object({
    data: AiDiagnosticModelOutputSchema,
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
  vehicle_id: 14,
  description:
    "Depuis ce matin, le voyant moteur orange reste allumé. Le véhicule tremble au ralenti et perd de la puissance pendant l’accélération, sans fumée ni bruit métallique.",
  answers: [],
  photo: null,
} as const;

const forbiddenPublicKeys = new Set([
  "authorization",
  "customer_id",
  "immatriculation",
  "registration_number",
  "token",
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

const main = async () => {
  const accessToken = process.env.DIRECTUS_TEST_TOKEN?.trim();
  if (accessToken === undefined || accessToken.length === 0) {
    throw new Error("DIRECTUS_TEST_TOKEN_MISSING");
  }

  const application = createApp();
  const server = application.listen(0, "127.0.0.1");

  try {
    await listenOnEphemeralPort(server);
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("LIVE_TEST_SERVER_ERROR");
    }

    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/ai/diagnostics`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
      },
    );

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("application/json")) {
      throw new Error("LIVE_TEST_INVALID_CONTENT_TYPE");
    }

    const payload = await readJson(response);
    if (response.status !== 200) {
      const parsedError = errorResponseSchema.safeParse(payload);
      throw new Error(
        parsedError.success ? parsedError.data.error.code : "LIVE_TEST_HTTP_ERROR",
      );
    }

    const parsedResponse = responseSchema.safeParse(payload);
    if (!parsedResponse.success) {
      throw new Error("LIVE_TEST_INVALID_DIAGNOSTIC");
    }

    const diagnostic = parsedResponse.data.data;
    const allowedServiceIds = new Set<number>(ALLOWED_SERVICE_TYPE_IDS);
    const allowedWorkshopTypes = new Set<string>(ALLOWED_WORKSHOP_TYPES);

    if (
      (diagnostic.diagnosis_status !== "ready" &&
        diagnostic.diagnosis_status !== "needs_questions") ||
      (diagnostic.suggested_service_type_id !== null &&
        !allowedServiceIds.has(diagnostic.suggested_service_type_id)) ||
      diagnostic.suggested_workshop_types.some(
        (workshopType) => !allowedWorkshopTypes.has(workshopType),
      ) ||
      containsForbiddenPublicKey(diagnostic) ||
      JSON.stringify(diagnostic).includes(accessToken)
    ) {
      throw new Error("LIVE_TEST_UNSAFE_DIAGNOSTIC");
    }

    console.log(JSON.stringify(diagnostic, null, 2));
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
}
