import {
  APIConnectionTimeoutError,
  AuthenticationError,
  RateLimitError,
} from "openai";
import { ZodError } from "zod";

export type AiDiagnosticErrorCode =
  | "AI_NOT_CONFIGURED"
  | "AI_REFUSED"
  | "AI_TIMEOUT"
  | "AI_RATE_LIMITED"
  | "AI_INVALID_OUTPUT"
  | "AI_PROVIDER_ERROR";

export type AiInvalidOutputReason =
  | "SDK_ZOD_REJECTED"
  | "RESPONSE_INCOMPLETE"
  | "OUTPUT_PARSED_MISSING"
  | "MODEL_SCHEMA_VIOLATION"
  | "BUSINESS_RULE_VIOLATION"
  | "IMAGE_FLAG_MISMATCH"
  | "SERVICE_NOT_IN_CATALOG"
  | "WORKSHOP_TYPE_NOT_IN_CATALOG"
  | "SERVICE_WORKSHOP_MISMATCH";

const safeIssuePaths = [
  "diagnosis_status",
  "problem_summary",
  "image_analysis",
  "image_analysis.image_provided",
  "image_analysis.useful",
  "image_analysis.observations",
  "image_analysis.photo_suggested",
  "image_analysis.requested_image_hint",
  "urgency_level",
  "driving_advice",
  "safety_message",
  "suggested_service_type_id",
  "suggested_workshop_types",
  "questions",
  "client_message",
  "sav_notes",
  "confidence",
] as const;

export type AiDiagnosticIssuePath = (typeof safeIssuePaths)[number];

export type AiInvalidOutputDetails = {
  reason: AiInvalidOutputReason;
  issue_paths: readonly AiDiagnosticIssuePath[];
  prompt_version: string;
};

const safeIssuePathSet = new Set<string>(safeIssuePaths);

export const sanitizeAiDiagnosticIssuePaths = (
  paths: readonly unknown[],
): AiDiagnosticIssuePath[] => {
  const sanitized = paths.filter(
    (path): path is AiDiagnosticIssuePath =>
      typeof path === "string" && safeIssuePathSet.has(path),
  );

  return [...new Set(sanitized)];
};

export const getSafeZodIssuePaths = (
  error: ZodError,
): AiDiagnosticIssuePath[] => {
  const candidates = error.issues.flatMap((issue) => {
    const stringSegments = issue.path.filter(
      (segment): segment is string => typeof segment === "string",
    );
    const rootPath = stringSegments[0];
    const nestedPath = stringSegments.slice(0, 2).join(".");

    return nestedPath.length > 0 && nestedPath !== rootPath
      ? [nestedPath, rootPath]
      : [rootPath];
  });

  return sanitizeAiDiagnosticIssuePaths(candidates);
};

const safeErrorMessages: Record<AiDiagnosticErrorCode, string> = {
  AI_NOT_CONFIGURED: "The AI service is not configured.",
  AI_REFUSED: "The AI service refused to process this request.",
  AI_TIMEOUT: "The AI service did not respond in time.",
  AI_RATE_LIMITED: "The AI service is temporarily rate limited.",
  AI_INVALID_OUTPUT: "The AI service returned an invalid response.",
  AI_PROVIDER_ERROR: "The AI service is temporarily unavailable.",
};

export class AiDiagnosticError extends Error {
  readonly code: AiDiagnosticErrorCode;
  readonly reason: AiInvalidOutputReason | undefined;
  readonly issue_paths: readonly AiDiagnosticIssuePath[] | undefined;
  readonly prompt_version: string | undefined;

  constructor(
    code: AiDiagnosticErrorCode,
    details?: AiInvalidOutputDetails,
  ) {
    super(safeErrorMessages[code]);
    this.name = "AiDiagnosticError";
    this.code = code;
    this.reason = code === "AI_INVALID_OUTPUT" ? details?.reason : undefined;
    this.issue_paths =
      code === "AI_INVALID_OUTPUT" ? details?.issue_paths : undefined;
    this.prompt_version =
      code === "AI_INVALID_OUTPUT" ? details?.prompt_version : undefined;
  }
}

const readErrorMetadata = (error: unknown) => {
  if (typeof error !== "object" || error === null) {
    return { name: "", status: undefined };
  }

  const candidate = error as { name?: unknown; status?: unknown };
  return {
    name: typeof candidate.name === "string" ? candidate.name : "",
    status: typeof candidate.status === "number" ? candidate.status : undefined,
  };
};

export const mapOpenAIError = (
  error: unknown,
  promptVersion: string,
): AiDiagnosticError => {
  if (error instanceof AiDiagnosticError) {
    return error;
  }

  if (error instanceof ZodError) {
    return new AiDiagnosticError("AI_INVALID_OUTPUT", {
      reason: "SDK_ZOD_REJECTED",
      issue_paths: getSafeZodIssuePaths(error),
      prompt_version: promptVersion,
    });
  }

  const metadata = readErrorMetadata(error);

  if (
    error instanceof APIConnectionTimeoutError ||
    metadata.name === "APIConnectionTimeoutError"
  ) {
    return new AiDiagnosticError("AI_TIMEOUT");
  }

  if (error instanceof RateLimitError || metadata.status === 429) {
    return new AiDiagnosticError("AI_RATE_LIMITED");
  }

  if (error instanceof AuthenticationError || metadata.status === 401) {
    return new AiDiagnosticError("AI_NOT_CONFIGURED");
  }

  return new AiDiagnosticError("AI_PROVIDER_ERROR");
};
