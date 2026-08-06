import { createHash } from "node:crypto";

import type { RequestHandler } from "express";

import { getDirectusAccessToken } from "./bearer-auth.js";
import { HttpError } from "./error-handler.js";

const DEFAULT_LIMIT = 5;
const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX_ENTRIES = 10_000;

type RateLimitEntry = {
  count: number;
  expiresAt: number;
};

export type AiRateLimitDecision = {
  allowed: boolean;
  retryAfterSeconds: number;
};

export interface AiRateLimiter {
  consume(accessToken: string): AiRateLimitDecision;
  readonly entryCount: number;
}

export type AiRateLimiterOptions = {
  limit?: number;
  windowMs?: number;
  maxEntries?: number;
  now?: () => number;
};

const hashToken = (accessToken: string) =>
  createHash("sha256").update(accessToken, "utf8").digest("hex");

// This bounded in-memory limiter is intentionally local to one Node.js instance.
export const createAiRateLimiter = (
  options: AiRateLimiterOptions = {},
): AiRateLimiter => {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const now = options.now ?? Date.now;
  const entries = new Map<string, RateLimitEntry>();

  const removeExpiredEntries = (currentTime: number) => {
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= currentTime) {
        entries.delete(key);
      }
    }
  };

  return {
    consume(accessToken) {
      const currentTime = now();
      removeExpiredEntries(currentTime);
      const key = hashToken(accessToken);
      const existing = entries.get(key);

      if (existing !== undefined) {
        if (existing.count >= limit) {
          return {
            allowed: false,
            retryAfterSeconds: Math.max(
              1,
              Math.ceil((existing.expiresAt - currentTime) / 1_000),
            ),
          };
        }

        existing.count += 1;
        return { allowed: true, retryAfterSeconds: 0 };
      }

      if (entries.size >= maxEntries) {
        const oldestKey = entries.keys().next().value as string | undefined;
        if (oldestKey !== undefined) {
          entries.delete(oldestKey);
        }
      }

      entries.set(key, { count: 1, expiresAt: currentTime + windowMs });
      return { allowed: true, retryAfterSeconds: 0 };
    },
    get entryCount() {
      return entries.size;
    },
  };
};

export const createAiRateLimitMiddleware = (
  rateLimiter: AiRateLimiter,
): RequestHandler =>
  (_request, response, next) => {
    const accessToken = getDirectusAccessToken(response);
    const decision = rateLimiter.consume(accessToken);

    if (!decision.allowed) {
      response.set("Retry-After", String(decision.retryAfterSeconds));
      next(
        new HttpError(
          429,
          "AI_RATE_LIMIT_EXCEEDED",
          "Too many AI diagnostic requests.",
        ),
      );
      return;
    }

    next();
  };
