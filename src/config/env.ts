import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const optionalSecretSchema = z.preprocess(
  (value) =>
    typeof value === "string" && value.trim().length === 0
      ? undefined
      : value,
  z.string().min(1).optional(),
);

const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
  DIRECTUS_URL: z.url().default("http://localhost:8055"),
  DIRECTUS_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(100)
    .max(30_000)
    .default(5_000),
  DIRECTUS_BOOKING_TOKEN: optionalSecretSchema,
  OPENAI_API_KEY: optionalSecretSchema,
  OPENAI_MODEL: z.string().trim().min(1).default("gpt-5.6-terra"),
  OPENAI_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(120_000)
    .default(30_000),
  OPENAI_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  CORS_ORIGINS: z
    .string()
    .default("http://localhost:8081,http://localhost:19006")
    .transform((value) =>
      value
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.url()).min(1)),
});

const parsedEnv = envSchema.safeParse({
  PORT: process.env.PORT,
  DIRECTUS_URL: process.env.DIRECTUS_URL,
  DIRECTUS_TIMEOUT_MS: process.env.DIRECTUS_TIMEOUT_MS,
  DIRECTUS_BOOKING_TOKEN: process.env.DIRECTUS_BOOKING_TOKEN,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  OPENAI_MODEL: process.env.OPENAI_MODEL,
  OPENAI_TIMEOUT_MS: process.env.OPENAI_TIMEOUT_MS,
  OPENAI_MAX_RETRIES: process.env.OPENAI_MAX_RETRIES,
  CORS_ORIGINS: process.env.CORS_ORIGINS,
});

if (!parsedEnv.success) {
  console.error("Invalid server environment configuration.");
  throw new Error("Invalid server environment configuration.");
}

export const env = parsedEnv.data;
