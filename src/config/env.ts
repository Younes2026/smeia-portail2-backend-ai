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
  OPENAI_API_KEY: optionalSecretSchema,
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
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  CORS_ORIGINS: process.env.CORS_ORIGINS,
});

if (!parsedEnv.success) {
  console.error("Invalid server environment configuration.");
  throw new Error("Invalid server environment configuration.");
}

export const env = parsedEnv.data;
