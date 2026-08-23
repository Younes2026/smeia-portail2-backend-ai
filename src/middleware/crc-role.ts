import type { RequestHandler, Response } from "express";

import {
  CrcDirectusActionStepError,
  DirectusError,
  type DirectusCurrentUser,
} from "../infrastructure/directus/index.js";
import { getDirectusAccessToken } from "./bearer-auth.js";
import { HttpError } from "./error-handler.js";

export type CrcAgentIdentity = {
  userId: string;
  roleId: string;
  roleName: string | null;
};

export type CrcRoleMiddlewareDependencies = {
  expectedRoleId: string;
  getCurrentUser(accessToken: string): Promise<DirectusCurrentUser>;
};

const crcAgentByResponse = new WeakMap<Response, CrcAgentIdentity>();

export const normalizeDirectusRoleId = (roleId: string) =>
  roleId.trim().toLowerCase();

export const createCrcRoleMiddleware = (
  dependencies: CrcRoleMiddlewareDependencies,
): RequestHandler => {
  const expectedRoleId = normalizeDirectusRoleId(
    dependencies.expectedRoleId,
  );
  if (expectedRoleId.length === 0) {
    throw new HttpError(
      503,
      "CRC_CONFIGURATION_UNAVAILABLE",
      "CRC access is not configured.",
    );
  }

  return async (_request, response, next) => {
    try {
      const accessToken = getDirectusAccessToken(response);
      const currentUser = await dependencies.getCurrentUser(accessToken);
      if (
        currentUser.role === undefined ||
        currentUser.role === null ||
        normalizeDirectusRoleId(currentUser.role.id) !== expectedRoleId
      ) {
        throw new HttpError(
          403,
          "CRC_ROLE_REQUIRED",
          "Agent CRC access is required.",
        );
      }

      crcAgentByResponse.set(response, {
        userId: currentUser.id,
        roleId: currentUser.role.id,
        roleName: currentUser.role.name ?? null,
      });
      next();
    } catch (error: unknown) {
      next(
        error instanceof DirectusError &&
          !(error instanceof CrcDirectusActionStepError)
          ? new CrcDirectusActionStepError(error)
          : error,
      );
    }
  };
};

export const getCrcAgentIdentity = (response: Response) => {
  const agent = crcAgentByResponse.get(response);
  if (agent === undefined) {
    throw new HttpError(
      403,
      "CRC_ROLE_REQUIRED",
      "Agent CRC access is required.",
    );
  }
  return agent;
};
