import assert from "node:assert/strict";
import test from "node:test";

import { createAiRateLimiter } from "./ai-rate-limit.js";

test("rejects the sixth request within one minute", () => {
  const limiter = createAiRateLimiter({ now: () => 1_000 });

  for (let index = 0; index < 5; index += 1) {
    assert.equal(limiter.consume("token-one").allowed, true);
  }

  assert.deepEqual(limiter.consume("token-one"), {
    allowed: false,
    retryAfterSeconds: 60,
  });
});

test("counts two client tokens independently", () => {
  const limiter = createAiRateLimiter({ now: () => 1_000 });

  for (let index = 0; index < 5; index += 1) {
    assert.equal(limiter.consume("token-one").allowed, true);
  }

  assert.equal(limiter.consume("token-one").allowed, false);
  assert.equal(limiter.consume("token-two").allowed, true);
  assert.equal(limiter.entryCount, 2);
});

test("does not expose or serialize the raw token in limiter state", () => {
  const rawToken = "sensitive-raw-token-placeholder";
  const limiter = createAiRateLimiter({ now: () => 1_000 });

  limiter.consume(rawToken);

  assert.equal(JSON.stringify(limiter).includes(rawToken), false);
  assert.equal(
    Object.getOwnPropertyNames(limiter).some((name) => name.includes(rawToken)),
    false,
  );
});

test("expires a window using an injected clock without sleeping", () => {
  let currentTime = 1_000;
  const limiter = createAiRateLimiter({ now: () => currentTime });

  for (let index = 0; index < 5; index += 1) {
    limiter.consume("token-one");
  }
  assert.equal(limiter.consume("token-one").allowed, false);

  currentTime += 60_000;

  assert.equal(limiter.consume("token-one").allowed, true);
});

test("bounds memory and evicts the oldest entry", () => {
  const limiter = createAiRateLimiter({
    now: () => 1_000,
    maxEntries: 2,
  });

  limiter.consume("token-one");
  limiter.consume("token-two");
  limiter.consume("token-three");

  assert.equal(limiter.entryCount, 2);
  assert.equal(limiter.consume("token-one").allowed, true);
  assert.equal(limiter.entryCount, 2);
});
