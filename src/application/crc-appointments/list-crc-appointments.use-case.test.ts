import assert from "node:assert/strict";
import test from "node:test";

import { createListCrcAppointmentsUseCase } from "./list-crc-appointments.use-case.js";

const ACCESS_TOKEN = "unit-test-crc-token-placeholder";

test("validates and forwards a normalized global CRC list query", async () => {
  const calls: Array<{ token: string; query: unknown }> = [];
  const useCase = createListCrcAppointmentsUseCase({
    async listAppointments(token, query) {
      calls.push({ token, query });
      return [];
    },
  });

  assert.deepEqual(
    await useCase(ACCESS_TOKEN, {
      queue: "proposed",
      showroom_id: "8",
      limit: "25",
    }),
    [],
  );
  assert.deepEqual(calls, [
    {
      token: ACCESS_TOKEN,
      query: {
        queue: "proposed",
        showroom_id: 8,
        limit: 25,
        offset: 0,
      },
    },
  ]);
});

test("rejects invalid CRC list filters before Directus", async () => {
  let calls = 0;
  const useCase = createListCrcAppointmentsUseCase({
    async listAppointments() {
      calls += 1;
      return [];
    },
  });

  await assert.rejects(() =>
    useCase(ACCESS_TOKEN, { sav_agent_id: "7" }),
  );
  assert.equal(calls, 0);
});
