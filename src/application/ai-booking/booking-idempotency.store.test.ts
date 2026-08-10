import assert from "node:assert/strict";
import test from "node:test";

import { BookingConfirmationError } from "./booking-confirmation-errors.js";
import { createBookingIdempotencyStore } from "./booking-idempotency.store.js";

const CLIENT_TOKEN = "unit-test-client-token-placeholder";
const KEY = "123e4567-e89b-42d3-a456-426614174000";

test("deduplicates simultaneous and repeated identical operations", async () => {
  const store = createBookingIdempotencyStore({
    now: () => new Date("2026-08-10T12:00:00.000Z"),
    ttlMs: 1_000,
    maxEntries: 10,
  });
  let calls = 0;
  const operation = async () => {
    calls += 1;
    await new Promise<void>((resolve) => setImmediate(resolve));
    return { appointment_id: 123 };
  };
  const body = { slot_token: "token", confirmation: true };

  const [first, second] = await Promise.all([
    store.execute(CLIENT_TOKEN, KEY, body, operation),
    store.execute(CLIENT_TOKEN, KEY, body, operation),
  ]);
  const replay = await store.execute(CLIENT_TOKEN, KEY, body, operation);
  assert.deepEqual(first, second);
  assert.deepEqual(replay, first);
  assert.equal(calls, 1);
});

test("rejects the same key with another body without running the operation", async () => {
  const store = createBookingIdempotencyStore({
    now: () => new Date("2026-08-10T12:00:00.000Z"),
    ttlMs: 1_000,
    maxEntries: 10,
  });
  await store.execute(CLIENT_TOKEN, KEY, { value: 1 }, async () => "ok");
  assert.throws(
    () => store.execute(CLIENT_TOKEN, KEY, { value: 2 }, async () => "bad"),
    (error: unknown) => {
      assert.ok(error instanceof BookingConfirmationError);
      assert.equal(error.code, "IDEMPOTENCY_CONFLICT");
      return true;
    },
  );
});

test("expires entries deterministically and enforces the maximum size", async () => {
  let now = new Date("2026-08-10T12:00:00.000Z");
  const store = createBookingIdempotencyStore({
    now: () => now,
    ttlMs: 1_000,
    maxEntries: 2,
  });
  await store.execute(CLIENT_TOKEN, KEY, { value: 1 }, async () => 1);
  await store.execute(
    CLIENT_TOKEN,
    "123e4567-e89b-42d3-a456-426614174001",
    { value: 2 },
    async () => 2,
  );
  assert.equal(store.getSize(), 2);
  await store.execute(
    CLIENT_TOKEN,
    "123e4567-e89b-42d3-a456-426614174002",
    { value: 3 },
    async () => 3,
  );
  assert.equal(store.getSize(), 2);
  now = new Date("2026-08-10T12:00:02.000Z");
  store.cleanup();
  assert.equal(store.getSize(), 0);
  assert.equal(JSON.stringify(store).includes(CLIENT_TOKEN), false);
});
