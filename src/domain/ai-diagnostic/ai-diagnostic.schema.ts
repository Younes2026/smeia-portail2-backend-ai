import { z } from "zod";

import {
  ALLOWED_SERVICE_TYPE_IDS,
  ALLOWED_WORKSHOP_TYPES,
} from "./ai-diagnostic.constants.js";

export const AiDiagnosticQuestionSchema = z
  .object({
    id: z.string().min(1),
    text: z.string().min(1),
    answer_type: z.enum(["yes_no", "single_choice", "free_text"]),
    options: z.array(z.string().min(1)).max(4),
  })
  .strict();

export const AiDiagnosticModelOutputSchema = z
  .object({
    diagnosis_status: z.enum(["needs_questions", "ready", "out_of_scope"]),
    problem_summary: z.string(),
    image_analysis: z
      .object({
        image_provided: z.boolean(),
        useful: z.boolean(),
        observations: z.string().nullable(),
        photo_suggested: z.boolean(),
        requested_image_hint: z.string().nullable(),
      })
      .strict(),
    urgency_level: z.enum(["low", "medium", "high", "critical"]),
    driving_advice: z.enum([
      "normal",
      "caution",
      "stop_if_possible",
      "do_not_drive",
    ]),
    safety_message: z.string().nullable(),
    suggested_service_type_id: z.literal(ALLOWED_SERVICE_TYPE_IDS).nullable(),
    suggested_workshop_types: z.array(z.enum(ALLOWED_WORKSHOP_TYPES)),
    questions: z.array(AiDiagnosticQuestionSchema).max(3),
    client_message: z.string(),
    sav_notes: z.string(),
    confidence: z.enum(["low", "medium", "high"]),
  })
  .strict();

export type AiDiagnosticQuestion = z.infer<
  typeof AiDiagnosticQuestionSchema
>;

export type AiDiagnosticModelOutput = z.infer<
  typeof AiDiagnosticModelOutputSchema
>;
