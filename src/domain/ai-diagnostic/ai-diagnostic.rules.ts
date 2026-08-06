import {
  ALLOWED_SERVICE_TYPE_IDS,
  ALLOWED_WORKSHOP_IDS,
} from "./ai-diagnostic.constants.js";
import type { AiDiagnosticModelOutput } from "./ai-diagnostic.schema.js";

const allowedServiceTypeIds = new Set<number>(ALLOWED_SERVICE_TYPE_IDS);
const allowedWorkshopIds = new Set<number>(ALLOWED_WORKSHOP_IDS);

export type AiDiagnosticBusinessRuleIssue = {
  path: string;
  message: string;
};

export type AiDiagnosticBusinessRulesResult =
  | { success: true }
  | {
      success: false;
      error: {
        code: "AI_DIAGNOSTIC_BUSINESS_RULE_VIOLATION";
        message: string;
        issues: AiDiagnosticBusinessRuleIssue[];
      };
    };

const hasAutomotiveAfterSalesScopeExplanation = (message: string) => {
  const normalizedMessage = message
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

  return (
    normalizedMessage.includes("sav") &&
    normalizedMessage.includes("automobile") &&
    (normalizedMessage.includes("uniquement") ||
      normalizedMessage.includes("seulement"))
  );
};

export const validateAiDiagnosticBusinessRules = (
  output: AiDiagnosticModelOutput,
): AiDiagnosticBusinessRulesResult => {
  const issues: AiDiagnosticBusinessRuleIssue[] = [];

  if (
    output.suggested_service_type_id !== null &&
    !allowedServiceTypeIds.has(output.suggested_service_type_id)
  ) {
    issues.push({
      path: "suggested_service_type_id",
      message: "The suggested service type is not allowed.",
    });
  }

  if (
    output.suggested_workshop_ids.some(
      (workshopId) => !allowedWorkshopIds.has(workshopId),
    )
  ) {
    issues.push({
      path: "suggested_workshop_ids",
      message: "One or more suggested workshops are not allowed.",
    });
  }

  if (
    new Set(output.suggested_workshop_ids).size !==
    output.suggested_workshop_ids.length
  ) {
    issues.push({
      path: "suggested_workshop_ids",
      message: "Suggested workshops must not contain duplicates.",
    });
  }

  if (output.diagnosis_status === "needs_questions") {
    if (output.questions.length < 1 || output.questions.length > 3) {
      issues.push({
        path: "questions",
        message: "A diagnostic awaiting answers must contain 1 to 3 questions.",
      });
    }

    if (output.suggested_service_type_id !== null) {
      issues.push({
        path: "suggested_service_type_id",
        message: "A service cannot be suggested while answers are still needed.",
      });
    }

    if (output.suggested_workshop_ids.length > 0) {
      issues.push({
        path: "suggested_workshop_ids",
        message: "Workshops cannot be suggested while answers are still needed.",
      });
    }
  }

  if (output.diagnosis_status === "ready") {
    if (output.questions.length > 0) {
      issues.push({
        path: "questions",
        message: "A ready diagnostic must not contain questions.",
      });
    }

    if (output.suggested_service_type_id === null) {
      issues.push({
        path: "suggested_service_type_id",
        message: "A ready diagnostic must suggest an allowed service type.",
      });
    }

    if (
      output.suggested_workshop_ids.length < 1 ||
      output.suggested_workshop_ids.length > 2
    ) {
      issues.push({
        path: "suggested_workshop_ids",
        message: "A ready diagnostic must suggest 1 or 2 allowed workshops.",
      });
    }
  }

  if (output.diagnosis_status === "out_of_scope") {
    if (output.questions.length > 0) {
      issues.push({
        path: "questions",
        message: "An out-of-scope response must not contain questions.",
      });
    }

    if (output.suggested_service_type_id !== null) {
      issues.push({
        path: "suggested_service_type_id",
        message: "An out-of-scope response must not suggest a service.",
      });
    }

    if (output.suggested_workshop_ids.length > 0) {
      issues.push({
        path: "suggested_workshop_ids",
        message: "An out-of-scope response must not suggest workshops.",
      });
    }

    if (!hasAutomotiveAfterSalesScopeExplanation(output.client_message)) {
      issues.push({
        path: "client_message",
        message:
          "An out-of-scope response must explain that only automotive after-sales requests are handled.",
      });
    }
  }

  if (!output.image_analysis.image_provided) {
    if (output.image_analysis.useful) {
      issues.push({
        path: "image_analysis.useful",
        message: "An image cannot be useful when no image was provided.",
      });
    }

    if (output.image_analysis.observations !== null) {
      issues.push({
        path: "image_analysis.observations",
        message: "Image observations must be null when no image was provided.",
      });
    }
  }

  if (
    output.image_analysis.photo_suggested &&
    (output.image_analysis.requested_image_hint === null ||
      output.image_analysis.requested_image_hint.trim().length === 0)
  ) {
    issues.push({
      path: "image_analysis.requested_image_hint",
      message: "A suggested photo must include a clear image hint.",
    });
  }

  if (output.urgency_level === "critical") {
    if (
      output.safety_message === null ||
      output.safety_message.trim().length === 0
    ) {
      issues.push({
        path: "safety_message",
        message: "A critical diagnostic must include a safety message.",
      });
    }

    if (
      output.driving_advice !== "stop_if_possible" &&
      output.driving_advice !== "do_not_drive"
    ) {
      issues.push({
        path: "driving_advice",
        message:
          "A critical diagnostic must advise stopping or not driving.",
      });
    }
  }

  if (issues.length > 0) {
    return {
      success: false,
      error: {
        code: "AI_DIAGNOSTIC_BUSINESS_RULE_VIOLATION",
        message: "The AI diagnostic output violates business rules.",
        issues,
      },
    };
  }

  return { success: true };
};
