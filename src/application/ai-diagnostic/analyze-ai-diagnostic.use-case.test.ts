import assert from "node:assert/strict";
import test from "node:test";

import type { AiDiagnosticModelOutput } from "../../domain/ai-diagnostic/index.js";
import {
  DirectusError,
  type DirectusAiCatalogs,
  type DirectusVehicleContext,
} from "../../infrastructure/directus/index.js";
import type { AiDiagnosticInput } from "./ai-diagnostic.input.js";
import {
  createAnalyzeAiDiagnosticUseCase,
  type AnalyzeAiDiagnosticUseCaseDependencies,
} from "./analyze-ai-diagnostic.use-case.js";

const ACCESS_TOKEN = "unit-test-client-token-placeholder";

const vehicle: DirectusVehicleContext = {
  vehicle_id: 14,
  brand: "BMW",
  model: "X1",
  year: 2020,
  mileage: 64_720,
};

const catalogs: DirectusAiCatalogs = {
  available_services: [
    { id: 2, name: "Diagnostic", code: "MEC-DIAG B" },
  ],
  available_workshops: [
    { id: 1, name: "Atelier Rapide", workshop_type: "diagnostic" },
  ],
};

const readyDiagnostic: AiDiagnosticModelOutput = {
  diagnosis_status: "ready",
  problem_summary: "Voyant moteur allumé.",
  image_analysis: {
    image_provided: false,
    useful: false,
    observations: null,
    photo_suggested: false,
    requested_image_hint: null,
  },
  urgency_level: "medium",
  driving_advice: "caution",
  safety_message: null,
  suggested_service_type_id: 2,
  suggested_workshop_types: ["diagnostic"],
  questions: [],
  client_message: "Un diagnostic est recommandé.",
  sav_notes: "Contrôler les codes défaut.",
  confidence: "medium",
};

const needsQuestionsDiagnostic: AiDiagnosticModelOutput = {
  ...readyDiagnostic,
  diagnosis_status: "needs_questions",
  suggested_service_type_id: null,
  suggested_workshop_types: [],
  questions: [
    {
      id: "question-1",
      text: "Le voyant clignote-t-il ?",
      answer_type: "yes_no",
      options: [],
    },
  ],
};

const validRequest = {
  vehicle_id: 14,
  description: "Le voyant moteur reste allumé et la voiture tremble.",
  answers: [],
  photo: null,
};

type HarnessOptions = {
  vehicleError?: Error;
  catalogsError?: Error;
  diagnostic?: AiDiagnosticModelOutput;
};

const createHarness = (options: HarnessOptions = {}) => {
  const vehicleCalls: Array<{ accessToken: string; vehicleId: unknown }> = [];
  const catalogTokens: string[] = [];
  const aiInputs: unknown[] = [];
  const dependencies: AnalyzeAiDiagnosticUseCaseDependencies = {
    async getVehicleContext(accessToken, vehicleId) {
      vehicleCalls.push({ accessToken, vehicleId });
      if (options.vehicleError !== undefined) {
        throw options.vehicleError;
      }
      return vehicle;
    },
    async getAiCatalogs(accessToken) {
      catalogTokens.push(accessToken);
      if (options.catalogsError !== undefined) {
        throw options.catalogsError;
      }
      return catalogs;
    },
    async analyzeDiagnostic(input) {
      aiInputs.push(input);
      return options.diagnostic ?? readyDiagnostic;
    },
  };

  return {
    aiInputs,
    catalogTokens,
    vehicleCalls,
    useCase: createAnalyzeAiDiagnosticUseCase(dependencies),
  };
};

test("orchestrates a successful text-only diagnostic", async () => {
  const harness = createHarness();

  const result = await harness.useCase(ACCESS_TOKEN, validRequest);

  assert.deepEqual(result, readyDiagnostic);
  assert.equal(harness.aiInputs.length, 1);
  assert.equal((harness.aiInputs[0] as AiDiagnosticInput).image, null);
});

test("passes a valid simulated photo to the AI service", async () => {
  const harness = createHarness();
  const photo = {
    mime_type: "image/jpeg" as const,
    data_url: "data:image/jpeg;base64,/9j/2Q==",
  };

  await harness.useCase(ACCESS_TOKEN, { ...validRequest, photo });

  assert.deepEqual((harness.aiInputs[0] as AiDiagnosticInput).image, photo);
});

test("maps complementary answers to untrusted previous answers", async () => {
  const harness = createHarness();

  await harness.useCase(ACCESS_TOKEN, {
    ...validRequest,
    answers: [
      {
        question: "Le voyant clignote-t-il ?",
        answer: "Non, il reste fixe.",
      },
    ],
  });

  assert.deepEqual(
    (harness.aiInputs[0] as AiDiagnosticInput).previous_answers,
    [
      {
        question_id: "answer-1",
        question: "Le voyant clignote-t-il ?",
        answer: "Non, il reste fixe.",
      },
    ],
  );
});

test("returns a needs_questions diagnostic unchanged", async () => {
  const harness = createHarness({ diagnostic: needsQuestionsDiagnostic });

  const result = await harness.useCase(ACCESS_TOKEN, validRequest);

  assert.equal(result.diagnosis_status, "needs_questions");
  assert.deepEqual(result.questions, needsQuestionsDiagnostic.questions);
});

test("returns a ready diagnostic unchanged after complementary answers", async () => {
  const harness = createHarness({ diagnostic: readyDiagnostic });

  const result = await harness.useCase(ACCESS_TOKEN, {
    ...validRequest,
    answers: [{ question: "Depuis quand ?", answer: "Depuis ce matin." }],
  });

  assert.equal(result.diagnosis_status, "ready");
});

test("uses empty answers and a null photo by default", async () => {
  const harness = createHarness();

  await harness.useCase(ACCESS_TOKEN, {
    vehicle_id: validRequest.vehicle_id,
    description: validRequest.description,
  });

  const input = harness.aiInputs[0] as AiDiagnosticInput;
  assert.deepEqual(input.previous_answers, []);
  assert.equal(input.image, null);
});

test("passes the same client token to both Directus reads", async () => {
  const harness = createHarness();

  await harness.useCase(ACCESS_TOKEN, validRequest);

  assert.deepEqual(harness.vehicleCalls, [
    { accessToken: ACCESS_TOKEN, vehicleId: 14 },
  ]);
  assert.deepEqual(harness.catalogTokens, [ACCESS_TOKEN]);
});

test("builds the AI input from the trusted Directus vehicle", async () => {
  const harness = createHarness();

  await assert.rejects(
    harness.useCase(ACCESS_TOKEN, {
      ...validRequest,
      brand: "Untrusted brand",
    }),
  );

  assert.equal(harness.aiInputs.length, 0);

  await harness.useCase(ACCESS_TOKEN, validRequest);
  assert.deepEqual((harness.aiInputs[0] as AiDiagnosticInput).vehicle, {
    brand: "BMW",
    model: "X1",
    year: 2020,
    mileage: 64_720,
  });
});

test("passes Directus services and only logical workshop types to the AI service", async () => {
  const harness = createHarness();

  await harness.useCase(ACCESS_TOKEN, validRequest);

  const input = harness.aiInputs[0] as AiDiagnosticInput;
  assert.deepEqual(input.available_services, catalogs.available_services);
  assert.deepEqual(input.available_workshop_types, [
    "diagnostic",
    "mecanique",
    "carrosserie",
    "peinture",
  ]);
  const serialized = JSON.stringify(input);
  assert.equal(serialized.includes("Atelier Rapide"), false);
  assert.equal(serialized.includes('"available_workshops"'), false);
});

test("does not send identifiers or sensitive vehicle data to OpenAI", async () => {
  const harness = createHarness();

  await harness.useCase(ACCESS_TOKEN, validRequest);

  const serialized = JSON.stringify(harness.aiInputs[0]);
  for (const forbidden of [
    "vehicle_id",
    "customer_id",
    "vin",
    "registration_number",
    ACCESS_TOKEN,
    "Authorization",
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test("calls the AI service exactly once after successful Directus reads", async () => {
  const harness = createHarness();

  await harness.useCase(ACCESS_TOKEN, validRequest);

  assert.equal(harness.aiInputs.length, 1);
});

test("rejects an invalid body before every external dependency", async () => {
  const harness = createHarness();

  await assert.rejects(harness.useCase(ACCESS_TOKEN, null));

  assert.equal(harness.vehicleCalls.length, 0);
  assert.equal(harness.catalogTokens.length, 0);
  assert.equal(harness.aiInputs.length, 0);
});

test("rejects every forbidden client-controlled property", async () => {
  const forbiddenProperties = [
    "customer_id",
    "brand",
    "model",
    "year",
    "mileage",
    "vin",
    "registration_number",
    "available_services",
    "available_workshops",
    "available_workshop_types",
    "suggested_service_type_id",
    "suggested_workshop_types",
    "status",
    "appointment_id",
    "openai_model",
    "instructions",
    "system_prompt",
  ];

  for (const property of forbiddenProperties) {
    const harness = createHarness();
    await assert.rejects(
      harness.useCase(ACCESS_TOKEN, { ...validRequest, [property]: "forbidden" }),
    );
    assert.equal(harness.vehicleCalls.length, 0);
    assert.equal(harness.catalogTokens.length, 0);
    assert.equal(harness.aiInputs.length, 0);
  }
});

test("rejects an invalid vehicle ID before external calls", async () => {
  const harness = createHarness();

  await assert.rejects(
    harness.useCase(ACCESS_TOKEN, { ...validRequest, vehicle_id: 0 }),
  );

  assert.equal(harness.vehicleCalls.length, 0);
  assert.equal(harness.aiInputs.length, 0);
});

test("rejects descriptions outside the length bounds", async () => {
  for (const description of ["Court", "x".repeat(3_001)]) {
    const harness = createHarness();
    await assert.rejects(
      harness.useCase(ACCESS_TOKEN, { ...validRequest, description }),
    );
    assert.equal(harness.vehicleCalls.length, 0);
    assert.equal(harness.aiInputs.length, 0);
  }
});

test("rejects more than five complementary answers", async () => {
  const harness = createHarness();
  const answer = { question: "Question ?", answer: "Réponse." };

  await assert.rejects(
    harness.useCase(ACCESS_TOKEN, {
      ...validRequest,
      answers: Array.from({ length: 6 }, () => answer),
    }),
  );

  assert.equal(harness.aiInputs.length, 0);
});

test("rejects an oversized answer question", async () => {
  const harness = createHarness();

  await assert.rejects(
    harness.useCase(ACCESS_TOKEN, {
      ...validRequest,
      answers: [{ question: "q".repeat(301), answer: "Réponse." }],
    }),
  );

  assert.equal(harness.aiInputs.length, 0);
});

test("rejects an oversized answer value", async () => {
  const harness = createHarness();

  await assert.rejects(
    harness.useCase(ACCESS_TOKEN, {
      ...validRequest,
      answers: [{ question: "Question ?", answer: "a".repeat(1_001) }],
    }),
  );

  assert.equal(harness.aiInputs.length, 0);
});

test("rejects an invalid photo before Directus or OpenAI", async () => {
  const harness = createHarness();

  await assert.rejects(
    harness.useCase(ACCESS_TOKEN, {
      ...validRequest,
      photo: {
        mime_type: "image/gif",
        data_url: "data:image/gif;base64,aGVsbG8=",
      },
    }),
  );

  assert.equal(harness.vehicleCalls.length, 0);
  assert.equal(harness.catalogTokens.length, 0);
  assert.equal(harness.aiInputs.length, 0);
});

test("does not call OpenAI when the vehicle read fails", async () => {
  const harness = createHarness({
    vehicleError: new DirectusError("DIRECTUS_VEHICLE_NOT_ACCESSIBLE"),
  });

  await assert.rejects(harness.useCase(ACCESS_TOKEN, validRequest));

  assert.equal(harness.aiInputs.length, 0);
});

test("does not call OpenAI when the catalog read fails", async () => {
  const harness = createHarness({
    catalogsError: new DirectusError("DIRECTUS_FORBIDDEN"),
  });

  await assert.rejects(harness.useCase(ACCESS_TOKEN, validRequest));

  assert.equal(harness.aiInputs.length, 0);
});

test("rejects an empty access token before all dependencies", async () => {
  const harness = createHarness();

  await assert.rejects(harness.useCase("", validRequest));

  assert.equal(harness.vehicleCalls.length, 0);
  assert.equal(harness.catalogTokens.length, 0);
  assert.equal(harness.aiInputs.length, 0);
});
