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

  constructor(code: AiDiagnosticErrorCode) {
    super(safeErrorMessages[code]);
    this.name = "AiDiagnosticError";
    this.code = code;
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

export const mapOpenAIError = (error: unknown): AiDiagnosticError => {
  if (error instanceof AiDiagnosticError) {
    return error;
  }

  if (error instanceof ZodError) {
    return new AiDiagnosticError("AI_INVALID_OUTPUT");
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
