import type { ErrorRequestHandler, RequestHandler } from "express";

type HttpError = Error & {
  status?: number;
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
  error: HttpError,
  request,
  response,
  _next,
) => {
  if (error instanceof SyntaxError && error.status === 400) {
    response.status(400).json({
      error: {
        code: "INVALID_JSON",
        message: "The request body contains invalid JSON.",
      },
    });
    return;
  }

  const status =
    typeof error.status === "number" &&
    error.status >= 400 &&
    error.status < 500
      ? error.status
      : 500;

  if (status === 500) {
    console.error("Unhandled server error.", {
      method: request.method,
      path: request.path,
      errorType: error.name,
    });
  }

  response.status(status).json({
    error: {
      code: status === 403 ? "CORS_ORIGIN_DENIED" : "INTERNAL_SERVER_ERROR",
      message:
        status === 403
          ? "The request origin is not allowed."
          : "An unexpected server error occurred.",
    },
  });
};
