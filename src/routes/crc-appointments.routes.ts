import { Router, type RequestHandler } from "express";

import type {
  GetCrcAppointmentUseCase,
  ListCrcAppointmentsUseCase,
} from "../application/crc-appointments/index.js";
import type { DirectusCurrentUser } from "../infrastructure/directus/index.js";
import {
  bearerAuthMiddleware,
  getDirectusAccessToken,
} from "../middleware/bearer-auth.js";
import { createCrcRoleMiddleware } from "../middleware/crc-role.js";
import { HttpError } from "../middleware/error-handler.js";

export type CrcAppointmentsRouterDependencies = {
  expectedRoleId: string;
  getCurrentUser(accessToken: string): Promise<DirectusCurrentUser>;
  listAppointments: ListCrcAppointmentsUseCase;
  getAppointment: GetCrcAppointmentUseCase;
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

  return router;
};
