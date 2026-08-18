import express, { Router, type RequestHandler } from "express";

import type {
  ConfirmAppointmentUseCase,
  SearchAppointmentAvailabilityUseCase,
} from "../application/ai-booking/index.js";
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
  confirmAppointment: ConfirmAppointmentUseCase;
  availabilityRateLimiter: AiRateLimiter;
  confirmationRateLimiter: AiRateLimiter;
};

const rejectQueryParameters: RequestHandler = (
  request,
  _response,
  next,
) => {
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
};

export const createAiBookingRouter = (
  dependencies: AiBookingRouterDependencies,
) => {
  const router = Router();

  router.post(
    "/api/ai/appointments/availability",
    bearerAuthMiddleware,
    rejectQueryParameters,
    createAiRateLimitMiddleware(
      dependencies.availabilityRateLimiter,
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

  router.post(
    "/api/ai/appointments/confirm",
    bearerAuthMiddleware,
    rejectQueryParameters,
    createAiRateLimitMiddleware(
      dependencies.confirmationRateLimiter,
      "BOOKING_RATE_LIMIT_EXCEEDED",
      "Too many appointment confirmation requests.",
    ),
    express.json({ limit: AI_BOOKING_JSON_LIMIT }),
    async (request, response, next) => {
      try {
        const accessToken = getDirectusAccessToken(response);
        const confirmation = await dependencies.confirmAppointment(
          accessToken,
          request.get("Idempotency-Key"),
          request.body,
        );
        response.status(201).json({ data: confirmation });
      } catch (error: unknown) {
        next(error);
      }
    },
  );

  return router;
};
