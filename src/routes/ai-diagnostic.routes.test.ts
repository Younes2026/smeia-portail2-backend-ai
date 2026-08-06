import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import type { Express } from "express";

import { app as defaultApp, createApp } from "../app.js";
import {
  createAnalyzeAiDiagnosticUseCase,
  type AnalyzeAiDiagnosticUseCase,
} from "../application/ai-diagnostic/index.js";
import type { AiDiagnosticModelOutput } from "../domain/ai-diagnostic/index.js";
import {
  DirectusError,
  type DirectusAiCatalogs,
  type DirectusVehicleContext,
} from "../infrastructure/directus/index.js";
import { AiDiagnosticError } from "../infrastructure/openai/index.js";
import { createAiRateLimiter } from "../middleware/ai-rate-limit.js";

const ACCESS_TOKEN = "unit-test-http-token-placeholder";

const readyDiagnostic: AiDiagnosticModelOutput = {
  diagnosis_status: "ready",
  problem_summary: "Voyant moteur allumé.",
  image_analysis: {
    image_provided: false,
    useful: false,
    observations: null,
    photo_suggested: false,
    requested_image_hint: null,
  },
  urgency_level: "medium",
  driving_advice: "caution",
  safety_message: null,
  suggested_service_type_id: 2,
  suggested_workshop_ids: [1],
  questions: [],
  client_message: "Un diagnostic est recommandé.",
  sav_notes: "Contrôler les codes défaut.",
  confidence: "medium",
};

const validBody = {
  vehicle_id: 14,
  description: "Le voyant moteur reste allumé et la voiture tremble.",
  answers: [],
  photo: null,
};

const vehicle: DirectusVehicleContext = {
  vehicle_id: 14,
  brand: "BMW",
  model: "X1",
  year: 2020,
  mileage: 64_720,
};

const catalogs: DirectusAiCatalogs = {
  available_services: [
    { id: 2, name: "Diagnostic", code: "MEC-DIAG B" },
  ],
  available_workshops: [
    { id: 1, name: "Atelier Rapide", workshop_type: "diagnostic" },
  ],
};

const withServer = async <T>(
  app: Express,
  run: (baseUrl: string) => Promise<T>,
) => {
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;

  try {
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
};

type HttpHarnessOptions = {
  analyzeDiagnostic?: AnalyzeAiDiagnosticUseCase;
  now?: () => number;
};

const createHttpHarness = (options: HttpHarnessOptions = {}) => {
  const calls: Array<{ accessToken: string; body: unknown }> = [];
  const useCase = createAnalyzeAiDiagnosticUseCase({
    async getVehicleContext() {
      return vehicle;
    },
    async getAiCatalogs() {
      return catalogs;
    },
    async analyzeDiagnostic() {
      return readyDiagnostic;
    },
  });
  const analyzeDiagnostic: AnalyzeAiDiagnosticUseCase =
    options.analyzeDiagnostic ??
    (async (accessToken, body) => {
      calls.push({ accessToken, body });
      return useCase(accessToken, body);
    });
  const rateLimiter =
    options.now === undefined
      ? createAiRateLimiter()
      : createAiRateLimiter({ now: options.now });

  return {
    calls,
    app: createApp({
      analyzeDiagnostic,
      rateLimiter,
    }),
  };
};

const postDiagnostic = (
  baseUrl: string,
  options: {
    authorization?: string;
    body?: unknown;
    rawBody?: string;
    path?: string;
  } = {},
) => {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (options.authorization !== undefined) {
    headers.set("Authorization", options.authorization);
  }

  return fetch(
    `${baseUrl}${options.path ?? "/api/ai/diagnostics"}`,
    {
      method: "POST",
      headers,
      body: options.rawBody ?? JSON.stringify(options.body ?? validBody),
    },
  );
};

const readJson = async (response: Response) =>
  (await response.json()) as Record<string, unknown>;

test("returns only the validated diagnostic under data", async () => {
  const harness = createHttpHarness();

  await withServer(harness.app, async (baseUrl) => {
    const response = await postDiagnostic(baseUrl, {
      authorization: `Bearer ${ACCESS_TOKEN}`,
    });
    const body = await readJson(response);

    assert.equal(response.status, 200);
    assert.deepEqual(body, { data: readyDiagnostic });
    assert.equal(harness.calls.length, 1);
    assert.equal(harness.calls[0]?.accessToken, ACCESS_TOKEN);
  });
});

test("returns 401 when Authorization is absent", async () => {
  const harness = createHttpHarness();

  await withServer(harness.app, async (baseUrl) => {
    const response = await postDiagnostic(baseUrl);
    const body = await readJson(response);

    assert.equal(response.status, 401);
    assert.equal((body.error as { code: string }).code, "AUTHORIZATION_REQUIRED");
    assert.equal(harness.calls.length, 0);
  });
});

test("returns 401 for a non-Bearer authorization scheme", async () => {
  const harness = createHttpHarness();

  await withServer(harness.app, async (baseUrl) => {
    const response = await postDiagnostic(baseUrl, {
      authorization: `Basic ${ACCESS_TOKEN}`,
    });

    assert.equal(response.status, 401);
    assert.equal(harness.calls.length, 0);
  });
});

test("returns 401 for an empty Bearer token", async () => {
  const harness = createHttpHarness();

  await withServer(harness.app, async (baseUrl) => {
    const response = await postDiagnostic(baseUrl, {
      authorization: "Bearer ",
    });

    assert.equal(response.status, 401);
    assert.equal(harness.calls.length, 0);
  });
});

test("returns 401 for a malformed Bearer token", async () => {
  const harness = createHttpHarness();

  await withServer(harness.app, async (baseUrl) => {
    const response = await postDiagnostic(baseUrl, {
      authorization: "Bearer malformed:token",
    });

    assert.equal(response.status, 401);
    assert.equal(harness.calls.length, 0);
  });
});

test("returns 401 for an oversized Bearer token", async () => {
  const harness = createHttpHarness();

  await withServer(harness.app, async (baseUrl) => {
    const response = await postDiagnostic(baseUrl, {
      authorization: `Bearer ${"a".repeat(4_097)}`,
    });

    assert.equal(response.status, 401);
    assert.equal(harness.calls.length, 0);
  });
});

test("never accepts the token from query parameters without Authorization", async () => {
  const harness = createHttpHarness();

  await withServer(harness.app, async (baseUrl) => {
    const response = await postDiagnostic(baseUrl, {
      path: `/api/ai/diagnostics?access_token=${ACCESS_TOKEN}`,
    });

    assert.equal(response.status, 401);
    assert.equal(harness.calls.length, 0);
  });
});

test("rejects every query parameter even with valid Authorization", async () => {
  const harness = createHttpHarness();

  await withServer(harness.app, async (baseUrl) => {
    const response = await postDiagnostic(baseUrl, {
      authorization: `Bearer ${ACCESS_TOKEN}`,
      path: `/api/ai/diagnostics?access_token=${ACCESS_TOKEN}`,
    });
    const serialized = JSON.stringify(await readJson(response));

    assert.equal(response.status, 400);
    assert.equal(serialized.includes(ACCESS_TOKEN), false);
    assert.equal(harness.calls.length, 0);
  });
});

test("rejects a token supplied in the body", async () => {
  const harness = createHttpHarness();

  await withServer(harness.app, async (baseUrl) => {
    const response = await postDiagnostic(baseUrl, {
      authorization: `Bearer ${ACCESS_TOKEN}`,
      body: { ...validBody, access_token: ACCESS_TOKEN },
    });

    assert.equal(response.status, 400);
    assert.equal(harness.calls.length, 1);
  });
});

test("returns 400 for invalid JSON without internal details", async () => {
  const harness = createHttpHarness();

  await withServer(harness.app, async (baseUrl) => {
    const response = await postDiagnostic(baseUrl, {
      authorization: `Bearer ${ACCESS_TOKEN}`,
      rawBody: "{invalid-json",
    });
    const serialized = JSON.stringify(await readJson(response));

    assert.equal(response.status, 400);
    assert.equal(serialized.includes("stack"), false);
    assert.equal(serialized.includes(ACCESS_TOKEN), false);
    assert.equal(harness.calls.length, 0);
  });
});

test("returns 400 for an invalid or additional body property", async () => {
  const harness = createHttpHarness();

  await withServer(harness.app, async (baseUrl) => {
    const response = await postDiagnostic(baseUrl, {
      authorization: `Bearer ${ACCESS_TOKEN}`,
      body: { ...validBody, customer_id: 99 },
    });

    assert.equal(response.status, 400);
  });
});

test("returns 400 for an invalid vehicle ID", async () => {
  const harness = createHttpHarness();

  await withServer(harness.app, async (baseUrl) => {
    const response = await postDiagnostic(baseUrl, {
      authorization: `Bearer ${ACCESS_TOKEN}`,
      body: { ...validBody, vehicle_id: 0 },
    });

    assert.equal(response.status, 400);
  });
});

test("returns 400 for descriptions outside accepted bounds", async () => {
  for (const description of ["Court", "x".repeat(3_001)]) {
    const harness = createHttpHarness();
    await withServer(harness.app, async (baseUrl) => {
      const response = await postDiagnostic(baseUrl, {
        authorization: `Bearer ${ACCESS_TOKEN}`,
        body: { ...validBody, description },
      });

      assert.equal(response.status, 400);
    });
  }
});

test("returns 400 for more than five answers", async () => {
  const harness = createHttpHarness();
  const answer = { question: "Question ?", answer: "Réponse." };

  await withServer(harness.app, async (baseUrl) => {
    const response = await postDiagnostic(baseUrl, {
      authorization: `Bearer ${ACCESS_TOKEN}`,
      body: {
        ...validBody,
        answers: Array.from({ length: 6 }, () => answer),
      },
    });

    assert.equal(response.status, 400);
  });
});

test("returns 400 for oversized answer fields", async () => {
  for (const answer of [
    { question: "q".repeat(301), answer: "Réponse." },
    { question: "Question ?", answer: "a".repeat(1_001) },
  ]) {
    const harness = createHttpHarness();
    await withServer(harness.app, async (baseUrl) => {
      const response = await postDiagnostic(baseUrl, {
        authorization: `Bearer ${ACCESS_TOKEN}`,
        body: { ...validBody, answers: [answer] },
      });

      assert.equal(response.status, 400);
    });
  }
});

test("returns 400 for an invalid photo before the use case continues", async () => {
  const harness = createHttpHarness();

  await withServer(harness.app, async (baseUrl) => {
    const response = await postDiagnostic(baseUrl, {
      authorization: `Bearer ${ACCESS_TOKEN}`,
      body: {
        ...validBody,
        photo: {
          mime_type: "image/gif",
          data_url: "data:image/gif;base64,aGVsbG8=",
        },
      },
    });

    assert.equal(response.status, 400);
  });
});

test("returns a controlled 413 for a body larger than eight megabytes", async () => {
  const harness = createHttpHarness();
  const oversizedBody = JSON.stringify({ padding: "x".repeat(8 * 1_024 * 1_024) });

  await withServer(harness.app, async (baseUrl) => {
    const response = await postDiagnostic(baseUrl, {
      authorization: `Bearer ${ACCESS_TOKEN}`,
      rawBody: oversizedBody,
    });
    const serialized = JSON.stringify(await readJson(response));

    assert.equal(response.status, 413);
    assert.equal(serialized.includes("stack"), false);
    assert.equal(serialized.includes("padding"), false);
    assert.equal(harness.calls.length, 0);
  });
});

test("does not expose the token, Directus context, or raw provider data", async () => {
  const harness = createHttpHarness();

  await withServer(harness.app, async (baseUrl) => {
    const response = await postDiagnostic(baseUrl, {
      authorization: `Bearer ${ACCESS_TOKEN}`,
    });
    const serialized = JSON.stringify(await readJson(response));

    for (const forbidden of [
      ACCESS_TOKEN,
      "available_services",
      "available_workshops",
      "vehicle_id",
      "output_parsed",
      "usage",
      "system_prompt",
    ]) {
      assert.equal(serialized.includes(forbidden), false);
    }
  });
});

test("maps a Directus 401 to HTTP 401", async () => {
  const harness = createHttpHarness({
    analyzeDiagnostic: async () => {
      throw new DirectusError("DIRECTUS_UNAUTHORIZED");
    },
  });

  await withServer(harness.app, async (baseUrl) => {
    const response = await postDiagnostic(baseUrl, {
      authorization: `Bearer ${ACCESS_TOKEN}`,
    });
    assert.equal(response.status, 401);
  });
});

test("maps a Directus 403 to HTTP 403", async () => {
  const harness = createHttpHarness({
    analyzeDiagnostic: async () => {
      throw new DirectusError("DIRECTUS_FORBIDDEN");
    },
  });

  await withServer(harness.app, async (baseUrl) => {
    const response = await postDiagnostic(baseUrl, {
      authorization: `Bearer ${ACCESS_TOKEN}`,
    });
    assert.equal(response.status, 403);
  });
});

test("maps an inaccessible vehicle to a generic HTTP 404", async () => {
  const harness = createHttpHarness({
    analyzeDiagnostic: async () => {
      throw new DirectusError("DIRECTUS_VEHICLE_NOT_ACCESSIBLE");
    },
  });

  await withServer(harness.app, async (baseUrl) => {
    const response = await postDiagnostic(baseUrl, {
      authorization: `Bearer ${ACCESS_TOKEN}`,
    });
    const serialized = JSON.stringify(await readJson(response));

    assert.equal(response.status, 404);
    assert.equal(serialized.includes("exists"), false);
    assert.equal(serialized.includes("owner"), false);
  });
});

test("maps upstream timeouts to HTTP 504", async () => {
  for (const error of [
    new DirectusError("DIRECTUS_TIMEOUT"),
    new AiDiagnosticError("AI_TIMEOUT"),
  ]) {
    const harness = createHttpHarness({
      analyzeDiagnostic: async () => {
        throw error;
      },
    });
    await withServer(harness.app, async (baseUrl) => {
      const response = await postDiagnostic(baseUrl, {
        authorization: `Bearer ${ACCESS_TOKEN}`,
      });
      assert.equal(response.status, 504);
    });
  }
});

test("maps controlled AI failures to HTTP 502", async () => {
  const harness = createHttpHarness({
    analyzeDiagnostic: async () => {
      throw new AiDiagnosticError("AI_PROVIDER_ERROR");
    },
  });

  await withServer(harness.app, async (baseUrl) => {
    const response = await postDiagnostic(baseUrl, {
      authorization: `Bearer ${ACCESS_TOKEN}`,
    });
    const serialized = JSON.stringify(await readJson(response));

    assert.equal(response.status, 502);
    assert.equal(serialized.includes("provider"), false);
  });
});

test("keeps AI_INVALID_OUTPUT diagnostics internal and out of logs", async () => {
  const sensitiveModelValue = "sensitive-model-output";
  const loggedValues: unknown[][] = [];
  const originalConsoleError = console.error;
  console.error = (...values: unknown[]) => {
    loggedValues.push(values);
  };
  const harness = createHttpHarness({
    analyzeDiagnostic: async () => {
      void sensitiveModelValue;
      throw new AiDiagnosticError("AI_INVALID_OUTPUT", {
        reason: "BUSINESS_RULE_VIOLATION",
        issue_paths: [
          "suggested_service_type_id",
          "suggested_workshop_ids",
        ],
        prompt_version: "1.2.0",
      });
    },
  });

  try {
    await withServer(harness.app, async (baseUrl) => {
      const response = await postDiagnostic(baseUrl, {
        authorization: `Bearer ${ACCESS_TOKEN}`,
      });
      const body = await readJson(response);
      const serialized = JSON.stringify(body);

      assert.equal(response.status, 502);
      assert.deepEqual(body, {
        error: {
          code: "AI_INVALID_OUTPUT",
          message: "The AI service could not complete the request.",
        },
      });
      assert.equal(serialized.includes("reason"), false);
      assert.equal(serialized.includes("issue_paths"), false);
      assert.equal(serialized.includes("prompt_version"), false);
      assert.equal(serialized.includes(sensitiveModelValue), false);
      assert.deepEqual(loggedValues, []);
    });
  } finally {
    console.error = originalConsoleError;
  }
});

test("returns a generic HTTP 500 without stack or request secrets", async () => {
  const harness = createHttpHarness({
    analyzeDiagnostic: async () => {
      throw new Error(`private failure ${ACCESS_TOKEN}`);
    },
  });

  await withServer(harness.app, async (baseUrl) => {
    const response = await postDiagnostic(baseUrl, {
      authorization: `Bearer ${ACCESS_TOKEN}`,
    });
    const serialized = JSON.stringify(await readJson(response));

    assert.equal(response.status, 500);
    assert.equal(serialized.includes("stack"), false);
    assert.equal(serialized.includes(ACCESS_TOKEN), false);
    assert.equal(serialized.includes("private failure"), false);
  });
});

test("returns 429 on the sixth request in the same window", async () => {
  const harness = createHttpHarness({ now: () => 1_000 });

  await withServer(harness.app, async (baseUrl) => {
    for (let index = 0; index < 5; index += 1) {
      const response = await postDiagnostic(baseUrl, {
        authorization: `Bearer ${ACCESS_TOKEN}`,
      });
      assert.equal(response.status, 200);
    }

    const response = await postDiagnostic(baseUrl, {
      authorization: `Bearer ${ACCESS_TOKEN}`,
    });
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("Retry-After"), "60");
    assert.equal(harness.calls.length, 5);
  });
});

test("counts two HTTP client tokens independently", async () => {
  const harness = createHttpHarness({ now: () => 1_000 });

  await withServer(harness.app, async (baseUrl) => {
    for (let index = 0; index < 5; index += 1) {
      for (const token of ["client-token-one", "client-token-two"]) {
        const response = await postDiagnostic(baseUrl, {
          authorization: `Bearer ${token}`,
        });
        assert.equal(response.status, 200);
      }
    }

    const secondTokenResponse = await postDiagnostic(baseUrl, {
      authorization: "Bearer client-token-two",
    });
    assert.equal(secondTokenResponse.status, 429);
    assert.equal(harness.calls.length, 10);
  });
});

test("the default server app can serve health without initializing OpenAI", async () => {
  await withServer(defaultApp, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/health`);

    assert.equal(response.status, 200);
    assert.deepEqual(await readJson(response), {
      status: "ok",
      service: "smeia-ai-backend",
    });
  });
});

test("keeps unknown routes as controlled 404 responses", async () => {
  const harness = createHttpHarness();

  await withServer(harness.app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/unknown-route`);
    const body = await readJson(response);

    assert.equal(response.status, 404);
    assert.equal((body.error as { code: string }).code, "NOT_FOUND");
  });
});

test("does not expose appointment or diagnostic persistence routes", async () => {
  const harness = createHttpHarness();

  await withServer(harness.app, async (baseUrl) => {
    for (const path of ["/items/appointments", "/items/ai_diagnostics"]) {
      const response = await postDiagnostic(baseUrl, {
        authorization: `Bearer ${ACCESS_TOKEN}`,
        path,
      });
      assert.equal(response.status, 404);
    }
    assert.equal(harness.calls.length, 0);
  });
});
