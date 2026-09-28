import type { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError } from "zod";

import {
  BookingAvailabilityError,
  BookingConfirmationError,
} from "../application/ai-booking/index.js";
import { CrcAppointmentActionError } from "../application/crc-appointments/index.js";
import {
  CrcDirectusActionStepError,
  DirectusError,
} from "../infrastructure/directus/index.js";
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
  diagnostic?: Record<string, unknown>,
) => {
  response.status(status).json({
    error: { code, message },
    ...(diagnostic === undefined ? {} : { diagnostic }),
  });
};

const getLocalCrcDiagnostic = (error: CrcDirectusActionStepError) => {
  if (process.env.NODE_ENV === "production" || error.step === undefined) {
    return undefined;
  }

  return {
    step: error.step,
    directus_http_status:
      error.diagnostic?.directus_http_status ?? error.httpStatus ?? 0,
    response_kind: error.diagnostic?.response_kind ?? "empty",
    data_kind: error.diagnostic?.data_kind ?? "missing",
    ...(error.diagnostic?.data_length === undefined
      ? {}
      : { data_length: error.diagnostic.data_length }),
    ...(error.diagnostic?.field_names === undefined
      ? {}
      : { field_names: error.diagnostic.field_names }),
  };
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

  if (error instanceof CrcAppointmentActionError) {
    const statusByCode = {
      CRC_APPOINTMENT_NOT_FOUND: 404,
      CRC_APPOINTMENT_NOT_TREATABLE: 409,
      CRC_APPOINTMENT_CONFLICT: 409,
      CRC_IDEMPOTENCY_CONFLICT: 409,
      CRC_HISTORY_WRITE_FAILED: 502,
      CRC_SLOT_TOKEN_INVALID: 400,
      CRC_SLOT_TOKEN_EXPIRED: 409,
      CRC_SLOT_CONTEXT_MISMATCH: 422,
      CRC_SLOT_NO_LONGER_AVAILABLE: 409,
      CRC_SLOT_VALIDATION_UNAVAILABLE: 503,
      CRC_WRITE_CONFIGURATION_UNAVAILABLE: 503,
    } as const;
    sendError(
      response,
      statusByCode[error.code],
      error.code,
      error.message,
    );
    return;
  }

  if (error instanceof BookingAvailabilityError) {
    const status = (() => {
      if (error.code === "BOOKING_AVAILABILITY_NOT_FOUND") {
        return 404;
      }
      if (error.code === "BOOKING_CONFIGURATION_ERROR") {
        return 503;
      }
      if (error.code === "BOOKING_SLOT_TOKEN_EXPIRED") {
        return 410;
      }
      if (error.code === "BOOKING_SLOT_TOKEN_INVALID") {
        return 400;
      }
      return 502;
    })();
    sendError(response, status, error.code, error.message);
    return;
  }

  if (error instanceof BookingConfirmationError) {
    const statusByCode = {
      INVALID_SLOT_TOKEN: 400,
      SLOT_OFFER_EXPIRED: 409,
      SLOT_NO_LONGER_AVAILABLE: 409,
      IDEMPOTENCY_CONFLICT: 409,
      BOOKING_CONTEXT_INVALID: 422,
      APPOINTMENT_CREATION_FAILED: 502,
      BOOKING_CONFIGURATION_UNAVAILABLE: 503,
    } as const;
    sendError(
      response,
      statusByCode[error.code],
      error.code,
      error.message,
    );
    return;
  }

  if (error instanceof CrcDirectusActionStepError) {
    const responseStatus = (() => {
      if (error.code === "DIRECTUS_UNAUTHORIZED") {
        return 401;
      }
      if (error.code === "DIRECTUS_FORBIDDEN") {
        return 403;
      }
      if (error.code === "DIRECTUS_TIMEOUT") {
        return 504;
      }
      return 502;
    })();
    sendError(
      response,
      responseStatus,
      error.code,
      "Directus could not complete the CRC action.",
      getLocalCrcDiagnostic(error),
    );
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
