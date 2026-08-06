process.env.DOTENV_CONFIG_QUIET = "true";
process.env.OPENAI_MAX_RETRIES = "0";

const [{ analyzeAiDiagnostic }, { env }, { AiDiagnosticError }] =
  await Promise.all([
    import("../src/application/ai-diagnostic/index.js"),
    import("../src/config/env.js"),
    import("../src/infrastructure/openai/index.js"),
  ]);

const input = {
  problem_description:
    "Depuis ce matin, le voyant moteur orange reste allumé en continu. Le véhicule démarre, mais il vibre au ralenti et manque de puissance pendant l’accélération. Je ne remarque ni fumée ni bruit métallique.",
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
    { id: 6, name: "Réparation carrosserie selon devis", code: "CAR" },
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
  available_workshops: [
    { id: 1, name: "Atelier Rapide", workshop_type: "diagnostic" },
    {
      id: 2,
      name: "Atelier mécanique & Diag",
      workshop_type: "mecanique",
    },
    {
      id: 3,
      name: "Atelier carrosserie",
      workshop_type: "carrosserie",
    },
    { id: 4, name: "Atelier peinture", workshop_type: "peinture" },
  ],
  image: null,
} as const;

try {
  const diagnostic = await analyzeAiDiagnostic(input);

  console.log(
    JSON.stringify(
      {
        model: env.OPENAI_MODEL,
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
