import { readFile, stat } from "node:fs/promises";
import type { Server } from "node:http";
import { fileURLToPath } from "node:url";

import { z } from "zod";

process.env.DOTENV_CONFIG_QUIET = "true";
process.env.OPENAI_MAX_RETRIES = "0";

const [
  { createApp },
  { MAX_AI_DIAGNOSTIC_IMAGE_BYTES },
  { env },
  {
    ALLOWED_SERVICE_TYPE_IDS,
    ALLOWED_WORKSHOP_TYPES,
    AiDiagnosticModelOutputSchema,
    validateAiDiagnosticBusinessRules,
  },
] = await Promise.all([
  import("../src/app.js"),
  import("../src/application/ai-diagnostic/index.js"),
  import("../src/config/env.js"),
  import("../src/domain/ai-diagnostic/index.js"),
]);

const imagePath = fileURLToPath(
  new URL("../local-test-assets/vehicle-test.jpg", import.meta.url),
);

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

const forbiddenPublicKeys = new Set([
  "authorization",
  "customer_id",
  "immatriculation",
  "registration_number",
  "token",
  "vehicle_id",
  "vin",
]);

const compatibleWorkshopTypesByServiceId = new Map<
  number,
  ReadonlySet<string>
>([
  [2, new Set(["diagnostic", "mecanique"])],
  [3, new Set(["diagnostic", "mecanique"])],
  [4, new Set(["carrosserie"])],
  [5, new Set(["peinture"])],
  [6, new Set(["carrosserie"])],
  [7, new Set(["peinture"])],
  [8, new Set(["diagnostic", "mecanique"])],
]);

const containsForbiddenPublicContent = (value: unknown): boolean => {
  if (typeof value === "string") {
    const normalizedValue = value.toLowerCase();
    return (
      normalizedValue.includes("data:image/") ||
      normalizedValue.includes(";base64,")
    );
  }

  if (Array.isArray(value)) {
    return value.some(containsForbiddenPublicContent);
  }

  if (typeof value !== "object" || value === null) {
    return false;
  }

  return Object.entries(value).some(
    ([key, nestedValue]) =>
      forbiddenPublicKeys.has(key.toLowerCase()) ||
      containsForbiddenPublicContent(nestedValue),
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

  const imageStats = await stat(imagePath);
  if (
    !imageStats.isFile() ||
    imageStats.size === 0 ||
    imageStats.size > MAX_AI_DIAGNOSTIC_IMAGE_BYTES
  ) {
    throw new Error("LIVE_TEST_INVALID_IMAGE");
  }

  const imageBytes = await readFile(imagePath);
  const hasJpegSignature =
    imageBytes.length >= 5 &&
    imageBytes[0] === 0xff &&
    imageBytes[1] === 0xd8 &&
    imageBytes[2] === 0xff &&
    imageBytes.at(-2) === 0xff &&
    imageBytes.at(-1) === 0xd9;

  if (!hasJpegSignature || imageBytes.length !== imageStats.size) {
    throw new Error("LIVE_TEST_INVALID_IMAGE");
  }

  const requestBody = {
    vehicle_id: 14,
    description:
      "Le voyant moteur orange reste allumé en continu. Le véhicule démarre normalement et je n’ai remarqué ni fumée ni bruit métallique. La photo montre le voyant présent sur le tableau de bord.",
    answers: [],
    photo: {
      mime_type: "image/jpeg",
      data_url: `data:image/jpeg;base64,${imageBytes.toString("base64")}`,
    },
  } as const;

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
    const businessRulesResult = validateAiDiagnosticBusinessRules(diagnostic);
    const allowedServiceIds = new Set<number>(ALLOWED_SERVICE_TYPE_IDS);
    const allowedWorkshopTypes = new Set<string>(ALLOWED_WORKSHOP_TYPES);
    const compatibleWorkshopTypes =
      diagnostic.suggested_service_type_id === null
        ? undefined
        : compatibleWorkshopTypesByServiceId.get(
            diagnostic.suggested_service_type_id,
          );

    if (
      !businessRulesResult.success ||
      (diagnostic.diagnosis_status !== "ready" &&
        diagnostic.diagnosis_status !== "needs_questions") ||
      !diagnostic.image_analysis.image_provided ||
      (diagnostic.image_analysis.useful &&
        (diagnostic.image_analysis.observations === null ||
          diagnostic.image_analysis.observations.trim().length === 0)) ||
      (diagnostic.image_analysis.observations !== null &&
        diagnostic.image_analysis.observations.trim().length === 0) ||
      diagnostic.problem_summary.trim().length === 0 ||
      diagnostic.client_message.trim().length === 0 ||
      diagnostic.sav_notes.trim().length === 0 ||
      (diagnostic.suggested_service_type_id !== null &&
        !allowedServiceIds.has(diagnostic.suggested_service_type_id)) ||
      diagnostic.suggested_workshop_types.some(
        (workshopType) => !allowedWorkshopTypes.has(workshopType),
      ) ||
      (diagnostic.suggested_service_type_id !== null &&
        (compatibleWorkshopTypes === undefined ||
          diagnostic.suggested_workshop_types.some(
            (workshopType) => !compatibleWorkshopTypes.has(workshopType),
          ))) ||
      containsForbiddenPublicContent(diagnostic) ||
      JSON.stringify(diagnostic).includes(accessToken)
    ) {
      throw new Error("LIVE_TEST_UNSAFE_DIAGNOSTIC");
    }

    console.log(
      JSON.stringify(
        {
          model: env.OPENAI_MODEL,
          image_size_bytes: imageStats.size,
          diagnostic,
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

  console.error(JSON.stringify({ error_code: errorCode }));
  process.exitCode = 1;
}
