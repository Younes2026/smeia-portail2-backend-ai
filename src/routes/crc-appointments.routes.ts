import express, { Router, type RequestHandler } from "express";

import type {
  GetCrcAppointmentUseCase,
  ListCrcAppointmentsUseCase,
  ExecuteCrcAppointmentActionUseCase,
} from "../application/crc-appointments/index.js";
import type { DirectusCurrentUser } from "../infrastructure/directus/index.js";
import {
  bearerAuthMiddleware,
  getDirectusAccessToken,
} from "../middleware/bearer-auth.js";
import { createCrcRoleMiddleware } from "../middleware/crc-role.js";
import { getCrcAgentIdentity } from "../middleware/crc-role.js";
import { HttpError } from "../middleware/error-handler.js";

export type CrcAppointmentsRouterDependencies = {
  expectedRoleId: string;
  getCurrentUser(accessToken: string): Promise<DirectusCurrentUser>;
  listAppointments: ListCrcAppointmentsUseCase;
  getAppointment: GetCrcAppointmentUseCase;
  executeAction: ExecuteCrcAppointmentActionUseCase;
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
        "Query parameters are not accepted for appointment details.",
      ),
    );
    return;
  }
  next();
};

export const createCrcAppointmentsRouter = (
  dependencies: CrcAppointmentsRouterDependencies,
) => {
  const router = Router();
  const requireCrcRole = createCrcRoleMiddleware({
    expectedRoleId: dependencies.expectedRoleId,
    getCurrentUser: dependencies.getCurrentUser,
  });
  const parseActionBody = express.json({ limit: "16kb" });

  const actionHandler = (
    action: "callback" | "reject" | "confirm",
  ): RequestHandler =>
    async (request, response, next) => {
      try {
        const result = await dependencies.executeAction({
          accessToken: getDirectusAccessToken(response),
          actorUserId: getCrcAgentIdentity(response).userId,
          appointmentId: request.params.appointmentId,
          action,
          idempotencyKey: request.get("Idempotency-Key"),
          body: request.body,
        });
        response.status(200).json({ data: result });
      } catch (error: unknown) {
        next(error);
      }
    };

  router.get(
    "/api/crc/appointments",
    bearerAuthMiddleware,
    requireCrcRole,
    async (request, response, next) => {
      try {
        const appointments = await dependencies.listAppointments(
          getDirectusAccessToken(response),
          request.query,
        );
        response.status(200).json({ data: appointments });
      } catch (error: unknown) {
        next(error);
      }
    },
  );

  router.get(
    "/api/crc/appointments/:appointmentId",
    bearerAuthMiddleware,
    requireCrcRole,
    rejectQueryParameters,
    async (request, response, next) => {
      try {
        const appointment = await dependencies.getAppointment(
          getDirectusAccessToken(response),
          request.params.appointmentId,
        );
        if (appointment === null) {
          throw new HttpError(
            404,
            "CRC_APPOINTMENT_NOT_FOUND",
            "The CRC appointment was not found.",
          );
        }
        response.status(200).json({ data: appointment });
      } catch (error: unknown) {
        next(error);
      }
    },
  );

  for (const action of ["callback", "reject", "confirm"] as const) {
    router.post(
      `/api/crc/appointments/:appointmentId/${action}`,
      bearerAuthMiddleware,
      requireCrcRole,
      rejectQueryParameters,
      parseActionBody,
      actionHandler(action),
    );
  }

  return router;
};
