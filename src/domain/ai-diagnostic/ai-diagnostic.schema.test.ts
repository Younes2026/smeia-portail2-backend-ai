import assert from "node:assert/strict";
import test from "node:test";

import {
  AiDiagnosticModelOutputSchema,
  type AiDiagnosticModelOutput,
  type AiDiagnosticQuestion,
} from "./ai-diagnostic.schema.js";
import { validateAiDiagnosticBusinessRules } from "./ai-diagnostic.rules.js";

const createQuestion = (): AiDiagnosticQuestion => ({
  id: "question_1",
  text: "Depuis quand le problème est-il présent ?",
  answer_type: "free_text",
  options: [],
});

const createReadyOutput = (): AiDiagnosticModelOutput => ({
  diagnosis_status: "ready",
  problem_summary: "Un bruit inhabituel est entendu au freinage.",
  image_analysis: {
    image_provided: false,
    useful: false,
    observations: null,
    photo_suggested: false,
    requested_image_hint: null,
  },
  urgency_level: "medium",
  driving_advice: "caution",
  safety_message: "Évitez les longs trajets avant le contrôle.",
  suggested_service_type_id: 2,
  suggested_workshop_ids: [1],
  questions: [],
  client_message: "Un contrôle du système de freinage est conseillé.",
  sav_notes: "Contrôler les éléments de freinage.",
  confidence: "medium",
});

const expectBusinessValid = (input: unknown) => {
  const parsed = AiDiagnosticModelOutputSchema.safeParse(input);
  assert.equal(parsed.success, true);

  if (!parsed.success) {
    return;
  }

  assert.deepEqual(validateAiDiagnosticBusinessRules(parsed.data), {
    success: true,
  });
};

const expectBusinessInvalid = (input: unknown, expectedPath: string) => {
  const parsed = AiDiagnosticModelOutputSchema.safeParse(input);
  assert.equal(parsed.success, true);

  if (!parsed.success) {
    return;
  }

  const result = validateAiDiagnosticBusinessRules(parsed.data);
  assert.equal(result.success, false);

  if (result.success) {
    return;
  }

  assert.equal(result.error.code, "AI_DIAGNOSTIC_BUSINESS_RULE_VIOLATION");
  assert.ok(result.error.issues.some((issue) => issue.path === expectedPath));
};

test("accepts a valid needs_questions response", () => {
  expectBusinessValid({
    ...createReadyOutput(),
    diagnosis_status: "needs_questions",
    suggested_service_type_id: null,
    suggested_workshop_ids: [],
    questions: [createQuestion()],
  });
});

test("accepts a valid ready response", () => {
  expectBusinessValid(createReadyOutput());
});

test("accepts a valid out_of_scope response", () => {
  expectBusinessValid({
    ...createReadyOutput(),
    diagnosis_status: "out_of_scope",
    suggested_service_type_id: null,
    suggested_workshop_ids: [],
    client_message:
      "Cet assistant traite uniquement les demandes SAV automobile.",
  });
});

test("accepts a valid response without a photo", () => {
  expectBusinessValid({
    ...createReadyOutput(),
    image_analysis: {
      image_provided: false,
      useful: false,
      observations: null,
      photo_suggested: true,
      requested_image_hint:
        "Vous pouvez ajouter une photo de la zone concernée si vous le souhaitez.",
    },
  });
});

test("rejects an unauthorized service type", () => {
  const result = AiDiagnosticModelOutputSchema.safeParse({
    ...createReadyOutput(),
    suggested_service_type_id: 9,
  });

  assert.equal(result.success, false);
});

test("rejects an unauthorized workshop", () => {
  const result = AiDiagnosticModelOutputSchema.safeParse({
    ...createReadyOutput(),
    suggested_workshop_ids: [5],
  });

  assert.equal(result.success, false);
});

test("rejects more than three questions", () => {
  const result = AiDiagnosticModelOutputSchema.safeParse({
    ...createReadyOutput(),
    diagnosis_status: "needs_questions",
    suggested_service_type_id: null,
    suggested_workshop_ids: [],
    questions: [
      createQuestion(),
      { ...createQuestion(), id: "question_2" },
      { ...createQuestion(), id: "question_3" },
      { ...createQuestion(), id: "question_4" },
    ],
  });

  assert.equal(result.success, false);
});

test("rejects ready without a service", () => {
  expectBusinessInvalid(
    { ...createReadyOutput(), suggested_service_type_id: null },
    "suggested_service_type_id",
  );
});

test("rejects ready without a workshop", () => {
  expectBusinessInvalid(
    { ...createReadyOutput(), suggested_workshop_ids: [] },
    "suggested_workshop_ids",
  );
});

test("rejects needs_questions with a recommendation", () => {
  expectBusinessInvalid(
    {
      ...createReadyOutput(),
      diagnosis_status: "needs_questions",
      questions: [createQuestion()],
    },
    "suggested_service_type_id",
  );
});

test("rejects observations when no image was provided", () => {
  expectBusinessInvalid(
    {
      ...createReadyOutput(),
      image_analysis: {
        ...createReadyOutput().image_analysis,
        observations: "Une fuite est visible.",
      },
    },
    "image_analysis.observations",
  );
});

test("rejects a suggested photo without an image hint", () => {
  expectBusinessInvalid(
    {
      ...createReadyOutput(),
      image_analysis: {
        ...createReadyOutput().image_analysis,
        photo_suggested: true,
        requested_image_hint: null,
      },
    },
    "image_analysis.requested_image_hint",
  );
});

test("rejects critical urgency without a safety message", () => {
  expectBusinessInvalid(
    {
      ...createReadyOutput(),
      urgency_level: "critical",
      driving_advice: "do_not_drive",
      safety_message: null,
    },
    "safety_message",
  );
});

test("rejects critical urgency with normal driving advice", () => {
  expectBusinessInvalid(
    {
      ...createReadyOutput(),
      urgency_level: "critical",
      driving_advice: "normal",
      safety_message: "Arrêtez le véhicule dans un endroit sûr.",
    },
    "driving_advice",
  );
});

test("rejects duplicate workshop IDs", () => {
  expectBusinessInvalid(
    { ...createReadyOutput(), suggested_workshop_ids: [1, 1] },
    "suggested_workshop_ids",
  );
});

test("rejects an additional JSON property", () => {
  const result = AiDiagnosticModelOutputSchema.safeParse({
    ...createReadyOutput(),
    internal_instruction: "not allowed",
  });

  assert.equal(result.success, false);
});

test("rejects more than four options for a question", () => {
  const result = AiDiagnosticModelOutputSchema.safeParse({
    ...createReadyOutput(),
    diagnosis_status: "needs_questions",
    suggested_service_type_id: null,
    suggested_workshop_ids: [],
    questions: [
      {
        ...createQuestion(),
        answer_type: "single_choice",
        options: ["A", "B", "C", "D", "E"],
      },
    ],
  });

  assert.equal(result.success, false);
});

test("rejects an out-of-scope response without a scope explanation", () => {
  expectBusinessInvalid(
    {
      ...createReadyOutput(),
      diagnosis_status: "out_of_scope",
      suggested_service_type_id: null,
      suggested_workshop_ids: [],
      client_message: "Je ne peux pas traiter cette demande.",
    },
    "client_message",
  );
});
