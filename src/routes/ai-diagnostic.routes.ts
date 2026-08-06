import express, { Router } from "express";

import type { AnalyzeAiDiagnosticUseCase } from "../application/ai-diagnostic/index.js";
import {
  createAiRateLimitMiddleware,
  type AiRateLimiter,
} from "../middleware/ai-rate-limit.js";
import {
  bearerAuthMiddleware,
  getDirectusAccessToken,
} from "../middleware/bearer-auth.js";
import { HttpError } from "../middleware/error-handler.js";

export const AI_DIAGNOSTIC_JSON_LIMIT = "8mb";

export type AiDiagnosticRouterDependencies = {
  analyzeDiagnostic: AnalyzeAiDiagnosticUseCase;
  rateLimiter: AiRateLimiter;
};

export const createAiDiagnosticRouter = (
  dependencies: AiDiagnosticRouterDependencies,
) => {
  const router = Router();

  router.post(
    "/api/ai/diagnostics",
    bearerAuthMiddleware,
    (request, _response, next) => {
      if (Object.keys(request.query).length > 0) {
        next(
          new HttpError(
            400,
            "INVALID_REQUEST",
            "Query parameters are not accepted.",
          ),
        );
        return;
      }
      next();
    },
    createAiRateLimitMiddleware(dependencies.rateLimiter),
    express.json({ limit: AI_DIAGNOSTIC_JSON_LIMIT }),
    async (request, response, next) => {
      try {
        const accessToken = getDirectusAccessToken(response);
        const diagnostic = await dependencies.analyzeDiagnostic(
          accessToken,
          request.body,
        );
        response.status(200).json({ data: diagnostic });
      } catch (error: unknown) {
        next(error);
      }
    },
  );

  return router;
};
