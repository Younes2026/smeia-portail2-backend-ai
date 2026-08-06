import assert from "node:assert/strict";
import test from "node:test";

import type { AiDiagnosticModelOutput } from "../../domain/ai-diagnostic/index.js";
import {
  AiDiagnosticError,
  type AiDiagnosticOpenAIClientFactory,
  type AiDiagnosticOpenAIRequest,
  type AiDiagnosticOpenAIResponse,
} from "../../infrastructure/openai/index.js";
import {
  MAX_AI_DIAGNOSTIC_IMAGE_BYTES,
  type AiDiagnosticInput,
} from "./ai-diagnostic.input.js";
import { createAiDiagnosticService } from "./ai-diagnostic.service.js";

const TEST_API_KEY = "unit-test-api-key-placeholder";

const createInput = (): AiDiagnosticInput => ({
  problem_description:
    "Un bruit métallique apparaît lorsque je freine à faible vitesse.",
  vehicle: {
    brand: "Marque test",
    model: "Modèle test",
    year: 2022,
    mileage: null,
  },
  previous_answers: [],
  available_services: [
    { id: 2, name: "Service test", code: "SERVICE_TEST" },
  ],
  available_workshops: [
    { id: 1, name: "Atelier test", workshop_type: "mechanical" },
  ],
  image: null,
});

const createReadyOutput = (): AiDiagnosticModelOutput => ({
  diagnosis_status: "ready",
  problem_summary: "Bruit métallique au freinage à faible vitesse.",
  image_analysis: {
    image_provided: false,
    useful: false,
    observations: null,
    photo_suggested: false,
    requested_image_hint: null,
  },
  urgency_level: "medium",
  driving_advice: "caution",
  safety_message: "Faites contrôler le véhicule rapidement.",
  suggested_service_type_id: 2,
  suggested_workshop_ids: [1],
  questions: [],
  client_message: "Un contrôle du freinage est recommandé.",
  sav_notes: "Contrôler le système de freinage.",
  confidence: "medium",
});

type MockHandler = (
  request: AiDiagnosticOpenAIRequest,
) => Promise<AiDiagnosticOpenAIResponse>;

const createHarness = (
  handler: MockHandler,
  apiKey: string | undefined = TEST_API_KEY,
) => {
  const requests: AiDiagnosticOpenAIRequest[] = [];
  const clientFactory: AiDiagnosticOpenAIClientFactory = () => ({
    async createResponse(request) {
      requests.push(request);
      return handler(request);
    },
  });

  return {
    requests,
    service: createAiDiagnosticService(
      {
        apiKey,
        model: "test-model",
        timeoutMs: 30_000,
        maxRetries: 2,
      },
      { clientFactory },
    ),
  };
};

const completedResponse = (
  outputParsed: unknown,
): AiDiagnosticOpenAIResponse => ({
  status: "completed",
  outputParsed,
  refused: false,
});

const expectAiError = async (
  promise: Promise<unknown>,
  expectedCode: AiDiagnosticError["code"],
) => {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof AiDiagnosticError);
    assert.equal(error.code, expectedCode);
    return true;
  });
};

test("analyzes text without adding an image input", async () => {
  const harness = createHarness(async () =>
    completedResponse(createReadyOutput()),
  );

  const result = await harness.service.analyzeAiDiagnostic(createInput());

  assert.equal(result.diagnosis_status, "ready");
  assert.equal(harness.requests.length, 1);
  const request = harness.requests[0];
  assert.ok(request);
  assert.equal(request.model, "test-model");
  assert.equal(request.store, false);
  assert.equal(request.text.format.type, "json_schema");
  assert.equal(request.text.format.name, "smeia_ai_diagnostic");
  assert.equal(request.text.format.strict, true);
  const message = request.input[0];
  assert.ok(message);
  assert.equal(message.content[0]?.type, "input_text");
  assert.equal(
    message.content.some((content) => content.type === "input_image"),
    false,
  );
});

test("analyzes an optional photo with high image detail", async () => {
  const imageDataUrl = "data:image/png;base64,aGVsbG8=";
  const output = createReadyOutput();
  output.image_analysis = {
    image_provided: true,
    useful: true,
    observations: "Une zone sombre est visible près de la roue.",
    photo_suggested: false,
    requested_image_hint: null,
  };
  const harness = createHarness(async () => completedResponse(output));

  await harness.service.analyzeAiDiagnostic({
    ...createInput(),
    image: { mime_type: "image/png", data_url: imageDataUrl },
  });

  const request = harness.requests[0];
  assert.ok(request);
  const imageContent = request.input[0]?.content.find(
    (content) => content.type === "input_image",
  );
  assert.ok(imageContent);
  assert.equal(imageContent.image_url, imageDataUrl);
  assert.equal(imageContent.detail, "high");
});

test("keeps a null photo non-blocking", async () => {
  const harness = createHarness(async () =>
    completedResponse(createReadyOutput()),
  );

  const result = await harness.service.analyzeAiDiagnostic({
    ...createInput(),
    image: null,
  });

  assert.equal(result.image_analysis.image_provided, false);
});

test("sends previous answers as input text", async () => {
  const harness = createHarness(async () =>
    completedResponse(createReadyOutput()),
  );
  const previousAnswer = {
    question_id: "question_1",
    question: "Depuis quand le bruit est-il présent ?",
    answer: "Depuis deux jours.",
  };

  await harness.service.analyzeAiDiagnostic({
    ...createInput(),
    previous_answers: [previousAnswer],
  });

  const textContent = harness.requests[0]?.input[0]?.content.find(
    (content) => content.type === "input_text",
  );
  assert.ok(textContent);
  const payload = JSON.parse(textContent.text) as {
    previous_answers: unknown[];
  };
  assert.deepEqual(payload.previous_answers, [previousAnswer]);
});

test("refuses an analysis when the API key is absent", async () => {
  let clientCreated = false;
  const clientFactory: AiDiagnosticOpenAIClientFactory = () => {
    clientCreated = true;
    throw new Error("The client must not be created.");
  };
  const service = createAiDiagnosticService(
    {
      apiKey: undefined,
      model: "test-model",
      timeoutMs: 30_000,
      maxRetries: 2,
    },
    { clientFactory },
  );

  await expectAiError(
    service.analyzeAiDiagnostic(createInput()),
    "AI_NOT_CONFIGURED",
  );
  assert.equal(clientCreated, false);
});

test("returns a valid ready output", async () => {
  const expected = createReadyOutput();
  const harness = createHarness(async () => completedResponse(expected));

  assert.deepEqual(
    await harness.service.analyzeAiDiagnostic(createInput()),
    expected,
  );
});

test("returns a valid needs_questions output", async () => {
  const expected: AiDiagnosticModelOutput = {
    ...createReadyOutput(),
    diagnosis_status: "needs_questions",
    suggested_service_type_id: null,
    suggested_workshop_ids: [],
    questions: [
      {
        id: "question_1",
        text: "Depuis quand ce bruit est-il présent ?",
        answer_type: "free_text",
        options: [],
      },
    ],
  };
  const harness = createHarness(async () => completedResponse(expected));

  assert.deepEqual(
    await harness.service.analyzeAiDiagnostic(createInput()),
    expected,
  );
});

test("returns a valid out_of_scope output", async () => {
  const expected: AiDiagnosticModelOutput = {
    ...createReadyOutput(),
    diagnosis_status: "out_of_scope",
    suggested_service_type_id: null,
    suggested_workshop_ids: [],
    client_message:
      "Cet assistant traite uniquement les demandes SAV automobile.",
  };
  const harness = createHarness(async () => completedResponse(expected));

  assert.deepEqual(
    await harness.service.analyzeAiDiagnostic(createInput()),
    expected,
  );
});

test("maps a model refusal to a controlled error", async () => {
  const harness = createHarness(async () => ({
    status: "completed",
    outputParsed: null,
    refused: true,
  }));

  await expectAiError(
    harness.service.analyzeAiDiagnostic(createInput()),
    "AI_REFUSED",
  );
});

test("rejects an absent structured output", async () => {
  const harness = createHarness(async () => completedResponse(null));

  await expectAiError(
    harness.service.analyzeAiDiagnostic(createInput()),
    "AI_INVALID_OUTPUT",
  );
});

test("rejects an incomplete provider response", async () => {
  const harness = createHarness(async () => ({
    status: "incomplete",
    outputParsed: null,
    refused: false,
  }));

  await expectAiError(
    harness.service.analyzeAiDiagnostic(createInput()),
    "AI_INVALID_OUTPUT",
  );
});

test("rejects an output that violates business rules", async () => {
  const invalidOutput = createReadyOutput();
  invalidOutput.suggested_workshop_ids = [1, 1];
  const harness = createHarness(async () => completedResponse(invalidOutput));

  await expectAiError(
    harness.service.analyzeAiDiagnostic(createInput()),
    "AI_INVALID_OUTPUT",
  );
});

test("rejects a service absent from the received catalog", async () => {
  const output = createReadyOutput();
  output.suggested_service_type_id = 3;
  const harness = createHarness(async () => completedResponse(output));

  await expectAiError(
    harness.service.analyzeAiDiagnostic(createInput()),
    "AI_INVALID_OUTPUT",
  );
});

test("rejects a workshop absent from the received catalog", async () => {
  const output = createReadyOutput();
  output.suggested_workshop_ids = [2];
  const harness = createHarness(async () => completedResponse(output));

  await expectAiError(
    harness.service.analyzeAiDiagnostic(createInput()),
    "AI_INVALID_OUTPUT",
  );
});

test("rejects an image larger than 5 MB before creating a client", async () => {
  const oversizedImage = Buffer.alloc(
    MAX_AI_DIAGNOSTIC_IMAGE_BYTES + 1,
  ).toString("base64");
  const harness = createHarness(async () =>
    completedResponse(createReadyOutput()),
  );

  await assert.rejects(
    harness.service.analyzeAiDiagnostic({
      ...createInput(),
      image: {
        mime_type: "image/png",
        data_url: `data:image/png;base64,${oversizedImage}`,
      },
    }),
  );
  assert.equal(harness.requests.length, 0);
});

test("rejects an unsupported image MIME type", async () => {
  const harness = createHarness(async () =>
    completedResponse(createReadyOutput()),
  );

  await assert.rejects(
    harness.service.analyzeAiDiagnostic({
      ...createInput(),
      image: {
        mime_type: "image/gif",
        data_url: "data:image/gif;base64,aGVsbG8=",
      },
    }),
  );
  assert.equal(harness.requests.length, 0);
});

test("maps a provider timeout to AI_TIMEOUT", async () => {
  const harness = createHarness(async () => {
    const error = new Error("provider timeout");
    error.name = "APIConnectionTimeoutError";
    throw error;
  });

  await expectAiError(
    harness.service.analyzeAiDiagnostic(createInput()),
    "AI_TIMEOUT",
  );
});

test("maps a provider rate limit to AI_RATE_LIMITED", async () => {
  const harness = createHarness(async () => {
    throw Object.assign(new Error("provider rate limit"), { status: 429 });
  });

  await expectAiError(
    harness.service.analyzeAiDiagnostic(createInput()),
    "AI_RATE_LIMITED",
  );
});

test("maps an unknown provider failure to AI_PROVIDER_ERROR", async () => {
  const harness = createHarness(async () => {
    throw new Error("untrusted provider details");
  });

  await expectAiError(
    harness.service.analyzeAiDiagnostic(createInput()),
    "AI_PROVIDER_ERROR",
  );
});

test("maps an authentication failure without exposing provider details", async () => {
  const harness = createHarness(async () => {
    throw Object.assign(new Error("invalid provider credential"), {
      status: 401,
    });
  });

  await expectAiError(
    harness.service.analyzeAiDiagnostic(createInput()),
    "AI_NOT_CONFIGURED",
  );
});

test("does not retain sensitive provider details in controlled errors", async () => {
  const input = createInput();
  const sensitiveImage = "data:image/png;base64,c2Vuc2l0aXZl";
  const harness = createHarness(async () => {
    throw new Error(
      `${TEST_API_KEY} ${input.problem_description} ${sensitiveImage}`,
    );
  });

  let caughtError: unknown;
  try {
    await harness.service.analyzeAiDiagnostic(input);
  } catch (error: unknown) {
    caughtError = error;
  }

  assert.ok(caughtError instanceof AiDiagnosticError);
  const serializedError = `${caughtError.message} ${JSON.stringify(caughtError)}`;
  assert.equal(serializedError.includes(TEST_API_KEY), false);
  assert.equal(serializedError.includes(input.problem_description), false);
  assert.equal(serializedError.includes(sensitiveImage), false);
});

test("rejects personal-data fields outside the input contract", async () => {
  const harness = createHarness(async () =>
    completedResponse(createReadyOutput()),
  );

  await assert.rejects(
    harness.service.analyzeAiDiagnostic({
      ...createInput(),
      client_email: "client@example.invalid",
    }),
  );
  assert.equal(harness.requests.length, 0);
});

test("rejects more than five previous answers", async () => {
  const previousAnswer = {
    question_id: "question_1",
    question: "Question ?",
    answer: "Réponse",
  };
  const harness = createHarness(async () =>
    completedResponse(createReadyOutput()),
  );

  await assert.rejects(
    harness.service.analyzeAiDiagnostic({
      ...createInput(),
      previous_answers: [
        previousAnswer,
        { ...previousAnswer, question_id: "question_2" },
        { ...previousAnswer, question_id: "question_3" },
        { ...previousAnswer, question_id: "question_4" },
        { ...previousAnswer, question_id: "question_5" },
        { ...previousAnswer, question_id: "question_6" },
      ],
    }),
  );
  assert.equal(harness.requests.length, 0);
});

test("rejects a problem description shorter than ten characters", async () => {
  const harness = createHarness(async () =>
    completedResponse(createReadyOutput()),
  );

  await assert.rejects(
    harness.service.analyzeAiDiagnostic({
      ...createInput(),
      problem_description: "Court",
    }),
  );
  assert.equal(harness.requests.length, 0);
});
