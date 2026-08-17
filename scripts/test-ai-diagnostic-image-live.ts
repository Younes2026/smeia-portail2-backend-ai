import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";

process.env.DOTENV_CONFIG_QUIET = "true";
process.env.OPENAI_MAX_RETRIES = "0";

const [
  {
    analyzeAiDiagnostic,
    MAX_AI_DIAGNOSTIC_IMAGE_BYTES,
  },
  { env },
  { AiDiagnosticError },
] = await Promise.all([
  import("../src/application/ai-diagnostic/index.js"),
  import("../src/config/env.js"),
  import("../src/infrastructure/openai/index.js"),
]);

const imagePath = fileURLToPath(
  new URL("../local-test-assets/vehicle-test.jpg", import.meta.url),
);

const allowedServiceIds = new Set([2, 3, 4, 5, 6, 7, 8]);
const allowedWorkshopTypes = new Set([
  "diagnostic",
  "mecanique",
  "carrosserie",
  "peinture",
]);

try {
  const imageStats = await stat(imagePath);
  if (!imageStats.isFile() || imageStats.size > MAX_AI_DIAGNOSTIC_IMAGE_BYTES) {
    throw new AiDiagnosticError("AI_INVALID_OUTPUT");
  }

  const imageBytes = await readFile(imagePath);
  const hasJpegSignature =
    imageBytes.length >= 5 &&
    imageBytes[0] === 0xff &&
    imageBytes[1] === 0xd8 &&
    imageBytes[2] === 0xff &&
    imageBytes.at(-2) === 0xff &&
    imageBytes.at(-1) === 0xd9;

  if (!hasJpegSignature) {
    throw new AiDiagnosticError("AI_INVALID_OUTPUT");
  }

  const diagnostic = await analyzeAiDiagnostic({
    problem_description:
      "Un voyant orange ressemblant à un moteur reste allumé sur le tableau de bord. Le véhicule démarre normalement et je ne remarque ni fumée ni bruit métallique. La photo jointe montre le voyant concerné.",
    vehicle: {
      brand: "BMW",
      model: "X1",
      year: 2020,
    },
    previous_answers: [],
    available_services: [
      { id: 2, name: "Diagnostic", code: "MEC-DIAG B" },
      {
        id: 3,
        name: "Etablissement devis mécanique",
        code: "MEC-DIAG B",
      },
      { id: 4, name: "Etablissement devis carrosserie", code: "CAR" },
      { id: 5, name: "Etablissement devis peinture", code: "PEINT" },
      {
        id: 6,
        name: "Réparation carrosserie selon devis",
        code: "CAR",
      },
      {
        id: 7,
        name: "Réparation peinture selon devis",
        code: "PEINT",
      },
      {
        id: 8,
        name: "Réparation mécanique selon devis",
        code: "MEC-DIAG B",
      },
    ],
    available_workshop_types: [
      "diagnostic",
      "mecanique",
      "carrosserie",
      "peinture",
    ],
    image: {
      mime_type: "image/jpeg",
      data_url: `data:image/jpeg;base64,${imageBytes.toString("base64")}`,
    },
  });

  if (!diagnostic.image_analysis.image_provided) {
    throw new AiDiagnosticError("AI_INVALID_OUTPUT");
  }

  if (
    diagnostic.image_analysis.useful &&
    diagnostic.image_analysis.observations === null
  ) {
    throw new AiDiagnosticError("AI_INVALID_OUTPUT");
  }

  if (
    (diagnostic.suggested_service_type_id !== null &&
      !allowedServiceIds.has(diagnostic.suggested_service_type_id)) ||
    diagnostic.suggested_workshop_types.some(
      (workshopType) => !allowedWorkshopTypes.has(workshopType),
    )
  ) {
    throw new AiDiagnosticError("AI_INVALID_OUTPUT");
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
} catch (error: unknown) {
  const errorCode =
    error instanceof AiDiagnosticError ? error.code : "AI_PROVIDER_ERROR";

  console.error(
    JSON.stringify({ model: env.OPENAI_MODEL, error_code: errorCode }),
  );
  process.exitCode = 1;
}
