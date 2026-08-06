import cors from "cors";
import express from "express";
import helmet from "helmet";

import {
  analyzeAiDiagnosticUseCase,
  type AnalyzeAiDiagnosticUseCase,
} from "./application/ai-diagnostic/index.js";
import { env } from "./config/env.js";
import {
  createAiRateLimiter,
  type AiRateLimiter,
} from "./middleware/ai-rate-limit.js";
import {
  errorHandler,
  notFoundHandler,
} from "./middleware/error-handler.js";
import { healthRouter } from "./routes/health.routes.js";
import { createAiDiagnosticRouter } from "./routes/ai-diagnostic.routes.js";

export type AppDependencies = {
  analyzeDiagnostic?: AnalyzeAiDiagnosticUseCase;
  rateLimiter?: AiRateLimiter;
};

const allowedOrigins = new Set(env.CORS_ORIGINS);

export const createApp = (dependencies: AppDependencies = {}) => {
  const createdApp = express();

  createdApp.disable("x-powered-by");
  createdApp.use(helmet());
  createdApp.use(
    cors({
      origin(origin, callback) {
        if (origin === undefined || allowedOrigins.has(origin)) {
          callback(null, true);
          return;
        }

        const error = new Error("CORS origin denied.") as Error & {
          status: number;
        };
        error.status = 403;
        callback(error);
      },
    }),
  );
  createdApp.use(
    createAiDiagnosticRouter({
      analyzeDiagnostic:
        dependencies.analyzeDiagnostic ?? analyzeAiDiagnosticUseCase,
      rateLimiter: dependencies.rateLimiter ?? createAiRateLimiter(),
    }),
  );
  createdApp.use(express.json({ limit: "1mb" }));

  createdApp.use(healthRouter);

  createdApp.use(notFoundHandler);
  createdApp.use(errorHandler);

  return createdApp;
};

export const app = createApp();
