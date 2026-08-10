import express, { Router } from "express";

import type { SearchAppointmentAvailabilityUseCase } from "../application/ai-booking/index.js";
import {
  createAiRateLimitMiddleware,
  type AiRateLimiter,
} from "../middleware/ai-rate-limit.js";
import {
  bearerAuthMiddleware,
  getDirectusAccessToken,
} from "../middleware/bearer-auth.js";
import { HttpError } from "../middleware/error-handler.js";

export const AI_BOOKING_JSON_LIMIT = "32kb";

export type AiBookingRouterDependencies = {
  searchAvailability: SearchAppointmentAvailabilityUseCase;
  rateLimiter: AiRateLimiter;
};

export const createAiBookingRouter = (
  dependencies: AiBookingRouterDependencies,
) => {
  const router = Router();

  router.post(
    "/api/ai/appointments/availability",
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
    createAiRateLimitMiddleware(
      dependencies.rateLimiter,
      "BOOKING_RATE_LIMIT_EXCEEDED",
      "Too many appointment availability requests.",
    ),
    express.json({ limit: AI_BOOKING_JSON_LIMIT }),
    async (request, response, next) => {
      try {
        const accessToken = getDirectusAccessToken(response);
        const availability = await dependencies.searchAvailability(
          accessToken,
          request.body,
        );
        response.status(200).json({ data: availability });
      } catch (error: unknown) {
        next(error);
      }
    },
  );

  return router;
};
