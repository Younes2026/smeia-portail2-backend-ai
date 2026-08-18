import assert from "node:assert/strict";
import test from "node:test";

import { DirectusError } from "./directus-errors.js";
import {
  createDirectusCurrentUserService,
  type DirectusCurrentUserService,
} from "./directus-current-user.service.js";
import type { DirectusFetch } from "./directus-http-client.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const CRC_ROLE_ID = "0234F31D-78EC-416E-BE7F-989132F2B065";
const ACCESS_TOKEN = "unit-test-crc-token-placeholder";

const expectDirectusError = async (
  operation: () => Promise<unknown>,
  code: DirectusError["code"],
) => {
  await assert.rejects(operation, (error: unknown) => {
    assert.ok(error instanceof DirectusError);
    assert.equal(error.code, code);
    return true;
  });
};

test("loads users/me with only the CRC identity fields and the user token", async () => {
  let capturedUrl: URL | null = null;
  let capturedInit: RequestInit | undefined;
  const fetchImplementation: DirectusFetch = async (input, init) => {
    capturedUrl = new URL(String(input));
    capturedInit = init;
    return Response.json({
      data: {
        id: USER_ID,
        role: { id: CRC_ROLE_ID, name: "Agent CRC" },
      },
    });
  };
  const service = createDirectusCurrentUserService({
    baseUrl: "https://directus.example.test/base",
    timeoutMs: 1_000,
    fetchImplementation,
  });

  assert.deepEqual(await service.getCurrentUser(ACCESS_TOKEN), {
    id: USER_ID,
    role: { id: CRC_ROLE_ID, name: "Agent CRC" },
  });
  assert.equal((capturedUrl as URL | null)?.pathname, "/base/users/me");
  assert.equal(
    (capturedUrl as URL | null)?.searchParams.get("fields"),
    "id,role.id,role.name",
  );
  assert.equal((capturedUrl as URL | null)?.toString().includes(ACCESS_TOKEN), false);
  assert.equal(capturedInit?.method, "GET");
  assert.equal(new Headers(capturedInit?.headers).get("Authorization"), `Bearer ${ACCESS_TOKEN}`);
});

test("rejects missing tokens before fetch", async () => {
  let calls = 0;
  const service = createDirectusCurrentUserService({
    baseUrl: "https://directus.example.test",
    timeoutMs: 1_000,
    fetchImplementation: async () => {
      calls += 1;
      return Response.json({});
    },
  });

  await expectDirectusError(
    () => service.getCurrentUser(""),
    "DIRECTUS_UNAUTHORIZED",
  );
  assert.equal(calls, 0);
});

test("maps rejected and malformed Directus identity responses", async () => {
  const createService = (
    fetchImplementation: DirectusFetch,
  ): DirectusCurrentUserService =>
    createDirectusCurrentUserService({
      baseUrl: "https://directus.example.test",
      timeoutMs: 1_000,
      fetchImplementation,
    });

  await expectDirectusError(
    () =>
      createService(async () => new Response(null, { status: 401 })).getCurrentUser(
        ACCESS_TOKEN,
      ),
    "DIRECTUS_UNAUTHORIZED",
  );
  await expectDirectusError(
    () =>
      createService(async () =>
        Response.json({ data: { id: USER_ID, role: CRC_ROLE_ID } }),
      ).getCurrentUser(ACCESS_TOKEN),
    "DIRECTUS_INVALID_RESPONSE",
  );
});
