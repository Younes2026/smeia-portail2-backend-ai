import type { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError } from "zod";

import { DirectusError } from "../infrastructure/directus/index.js";
import { AiDiagnosticError } from "../infrastructure/openai/index.js";

type ErrorWithStatus = Error & {
  status?: number;
  type?: string;
};

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
}

const sendError = (
  response: Parameters<ErrorRequestHandler>[2],
  status: number,
  code: string,
  message: string,
) => {
  response.status(status).json({ error: { code, message } });
};

export const notFoundHandler: RequestHandler = (_request, response) => {
  response.status(404).json({
    error: {
      code: "NOT_FOUND",
      message: "Route not found.",
    },
  });
};

export const errorHandler: ErrorRequestHandler = (
  error: ErrorWithStatus,
  request,
  response,
  _next,
) => {
  if (error instanceof SyntaxError && error.status === 400) {
    sendError(
      response,
      400,
      "INVALID_JSON",
      "The request body contains invalid JSON.",
    );
    return;
  }

  if (error.status === 413 || error.type === "entity.too.large") {
    sendError(
      response,
      413,
      "PAYLOAD_TOO_LARGE",
      "The request body is too large.",
    );
    return;
  }

  if (error instanceof ZodError) {
    sendError(response, 400, "INVALID_REQUEST", "The request is invalid.");
    return;
  }

  if (error instanceof HttpError) {
    sendError(response, error.status, error.code, error.message);
    return;
  }

  if (error instanceof DirectusError) {
    if (error.code === "DIRECTUS_UNAUTHORIZED") {
      sendError(response, 401, error.code, "Authentication was rejected.");
      return;
    }

    if (error.code === "DIRECTUS_FORBIDDEN") {
      sendError(response, 403, error.code, "Directus access is forbidden.");
      return;
    }

    if (error.code === "DIRECTUS_VEHICLE_NOT_ACCESSIBLE") {
      sendError(response, 404, error.code, "The vehicle is not accessible.");
      return;
    }

    if (error.code === "DIRECTUS_INVALID_VEHICLE_ID") {
      sendError(response, 400, error.code, "The vehicle ID is invalid.");
      return;
    }

    if (error.code === "DIRECTUS_TIMEOUT") {
      sendError(response, 504, error.code, "The upstream service timed out.");
      return;
    }

    sendError(
      response,
      502,
      "DIRECTUS_UPSTREAM_ERROR",
      "The upstream service returned an invalid response.",
    );
    return;
  }

  if (error instanceof AiDiagnosticError) {
    if (error.code === "AI_TIMEOUT") {
      sendError(response, 504, error.code, "The AI service timed out.");
      return;
    }

    sendError(
      response,
      502,
      error.code,
      "The AI service could not complete the request.",
    );
    return;
  }

  if (error.status === 403) {
    sendError(
      response,
      403,
      "CORS_ORIGIN_DENIED",
      "The request origin is not allowed.",
    );
    return;
  }

  console.error("Unhandled server error.", {
    method: request.method,
    path: request.path,
    errorType: error.name,
  });

  sendError(
    response,
    500,
    "INTERNAL_SERVER_ERROR",
    "An unexpected server error occurred.",
  );
};
