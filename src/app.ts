import cors from "cors";
import express from "express";
import helmet from "helmet";

import {
  analyzeAiDiagnosticUseCase,
  type AnalyzeAiDiagnosticUseCase,
} from "./application/ai-diagnostic/index.js";
import {
  confirmAppointmentUseCase,
  searchAppointmentAvailabilityUseCase,
  type ConfirmAppointmentUseCase,
  type SearchAppointmentAvailabilityUseCase,
} from "./application/ai-booking/index.js";
import {
  getCrcAppointmentUseCase,
  listCrcAppointmentsUseCase,
  executeCrcAppointmentActionUseCase,
  type ExecuteCrcAppointmentActionUseCase,
  type GetCrcAppointmentUseCase,
  type ListCrcAppointmentsUseCase,
} from "./application/crc-appointments/index.js";
import { env } from "./config/env.js";
import {
  getDirectusCurrentUser,
  type DirectusCurrentUser,
} from "./infrastructure/directus/index.js";
import {
  createAiRateLimiter,
  type AiRateLimiter,
} from "./middleware/ai-rate-limit.js";
import {
  errorHandler,
  notFoundHandler,
} from "./middleware/error-handler.js";
import { healthRouter } from "./routes/health.routes.js";
import { createAiBookingRouter } from "./routes/ai-booking.routes.js";
import { createAiDiagnosticRouter } from "./routes/ai-diagnostic.routes.js";
import { createCrcAppointmentsRouter } from "./routes/crc-appointments.routes.js";

export const BOOKING_AVAILABILITY_RATE_LIMIT_PER_MINUTE = 12;

export type AppDependencies = {
  analyzeDiagnostic?: AnalyzeAiDiagnosticUseCase;
  rateLimiter?: AiRateLimiter;
  searchAppointmentAvailability?: SearchAppointmentAvailabilityUseCase;
  confirmAppointment?: ConfirmAppointmentUseCase;
  bookingAvailabilityRateLimiter?: AiRateLimiter;
  bookingConfirmationRateLimiter?: AiRateLimiter;
  crcRoleId?: string;
  getDirectusCurrentUser?: (
    accessToken: string,
  ) => Promise<DirectusCurrentUser>;
  listCrcAppointments?: ListCrcAppointmentsUseCase;
  getCrcAppointment?: GetCrcAppointmentUseCase;
  executeCrcAppointmentAction?: ExecuteCrcAppointmentActionUseCase;
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
  createdApp.use(
    createAiBookingRouter({
      searchAvailability:
        dependencies.searchAppointmentAvailability ??
        searchAppointmentAvailabilityUseCase,
      confirmAppointment:
        dependencies.confirmAppointment ?? confirmAppointmentUseCase,
      availabilityRateLimiter:
        dependencies.bookingAvailabilityRateLimiter ??
        createAiRateLimiter({
          limit: BOOKING_AVAILABILITY_RATE_LIMIT_PER_MINUTE,
        }),
      confirmationRateLimiter:
        dependencies.bookingConfirmationRateLimiter ?? createAiRateLimiter(),
    }),
  );
  createdApp.use(
    createCrcAppointmentsRouter({
      expectedRoleId: dependencies.crcRoleId ?? env.DIRECTUS_CRC_ROLE_ID,
      getCurrentUser:
        dependencies.getDirectusCurrentUser ?? getDirectusCurrentUser,
      listAppointments:
        dependencies.listCrcAppointments ?? listCrcAppointmentsUseCase,
      getAppointment:
        dependencies.getCrcAppointment ?? getCrcAppointmentUseCase,
      executeAction:
        dependencies.executeCrcAppointmentAction ??
        executeCrcAppointmentActionUseCase,
    }),
  );
  createdApp.use(express.json({ limit: "1mb" }));

  createdApp.use(healthRouter);

  createdApp.use(notFoundHandler);
  createdApp.use(errorHandler);

  return createdApp;
};

export const app = createApp();
