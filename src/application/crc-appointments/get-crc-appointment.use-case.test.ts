import assert from "node:assert/strict";
import test from "node:test";

import { createGetCrcAppointmentUseCase } from "./get-crc-appointment.use-case.js";

const ACCESS_TOKEN = "unit-test-crc-token-placeholder";

test("validates and forwards the numeric CRC appointment ID", async () => {
  const calls: Array<{ token: string; appointmentId: number }> = [];
  const useCase = createGetCrcAppointmentUseCase({
    async getAppointment(token, appointmentId) {
      calls.push({ token, appointmentId });
      return null;
    },
  });

  assert.equal(await useCase(ACCESS_TOKEN, "42"), null);
  assert.deepEqual(calls, [{ token: ACCESS_TOKEN, appointmentId: 42 }]);
});

test("rejects an invalid CRC appointment ID before Directus", async () => {
  let calls = 0;
  const useCase = createGetCrcAppointmentUseCase({
    async getAppointment() {
      calls += 1;
      return null;
    },
  });

  await assert.rejects(() => useCase(ACCESS_TOKEN, "not-an-id"));
  assert.equal(calls, 0);
});
