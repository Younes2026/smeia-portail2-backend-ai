import assert from "node:assert/strict";
import test from "node:test";

import type {
  NextFunction,
  Request,
  Response,
} from "express";

import { bearerAuthMiddleware } from "./bearer-auth.js";
import {
  createCrcRoleMiddleware,
  getCrcAgentIdentity,
  normalizeDirectusRoleId,
} from "./crc-role.js";
import { HttpError } from "./error-handler.js";

const CRC_ROLE_ID = "0234F31D-78EC-416E-BE7F-989132F2B065";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const ACCESS_TOKEN = "unit-test-crc-token-placeholder";

const createRequest = (authorization: string) =>
  ({
    get(name: string) {
      return name.toLowerCase() === "authorization"
        ? authorization
        : undefined;
    },
  }) as Request;

const runBearerMiddleware = (request: Request, response: Response) => {
  let forwardedError: unknown;
  bearerAuthMiddleware(
    request,
    response,
    ((error?: unknown) => {
      forwardedError = error;
    }) as NextFunction,
  );
  return forwardedError;
};

test("normalizes Directus role UUID casing", () => {
  assert.equal(
    normalizeDirectusRoleId(` ${CRC_ROLE_ID} `),
    CRC_ROLE_ID.toLowerCase(),
  );
});

test("authorizes the configured Agent CRC role without sav_agents", async () => {
  const request = createRequest(`Bearer ${ACCESS_TOKEN}`);
  const response = {} as Response;
  assert.equal(runBearerMiddleware(request, response), undefined);
  let forwardedError: unknown;
  let receivedToken: string | null = null;
  const middleware = createCrcRoleMiddleware({
    expectedRoleId: CRC_ROLE_ID.toLowerCase(),
    async getCurrentUser(accessToken) {
      receivedToken = accessToken;
      return {
        id: USER_ID,
        role: { id: CRC_ROLE_ID, name: "Agent CRC" },
      };
    },
  });

  await middleware(
    request,
    response,
    ((error?: unknown) => {
      forwardedError = error;
    }) as NextFunction,
  );

  assert.equal(forwardedError, undefined);
  assert.equal(receivedToken, ACCESS_TOKEN);
  assert.deepEqual(getCrcAgentIdentity(response), {
    userId: USER_ID,
    roleId: CRC_ROLE_ID,
    roleName: "Agent CRC",
  });
});

test("rejects every non-CRC role with a controlled 403", async () => {
  const request = createRequest(`Bearer ${ACCESS_TOKEN}`);
  const response = {} as Response;
  assert.equal(runBearerMiddleware(request, response), undefined);
  let forwardedError: unknown;
  const middleware = createCrcRoleMiddleware({
    expectedRoleId: CRC_ROLE_ID,
    async getCurrentUser() {
      return {
        id: USER_ID,
        role: {
          id: "22222222-2222-4222-8222-222222222222",
          name: "Client",
        },
      };
    },
  });

  await middleware(
    request,
    response,
    ((error?: unknown) => {
      forwardedError = error;
    }) as NextFunction,
  );

  assert.ok(forwardedError instanceof HttpError);
  assert.equal(forwardedError.status, 403);
  assert.equal(forwardedError.code, "CRC_ROLE_REQUIRED");
});

test("rejects an empty expected role configuration", () => {
  assert.throws(
    () =>
      createCrcRoleMiddleware({
        expectedRoleId: " ",
        async getCurrentUser() {
          throw new Error("must not be called");
        },
      }),
    (error: unknown) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.status, 503);
      return true;
    },
  );
});
