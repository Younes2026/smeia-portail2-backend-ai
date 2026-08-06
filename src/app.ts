import cors from "cors";
import express from "express";
import helmet from "helmet";

import { env } from "./config/env.js";
import {
  errorHandler,
  notFoundHandler,
} from "./middleware/error-handler.js";
import { healthRouter } from "./routes/health.routes.js";

export const app = express();

const allowedOrigins = new Set(env.CORS_ORIGINS);

app.disable("x-powered-by");
app.use(helmet());
app.use(
  cors({
    origin(origin, callback) {
      if (origin === undefined || allowedOrigins.has(origin)) {
        callback(null, true);
        return;
      }

      const error = new Error("CORS origin denied.") as Error & {
        status: number;
      };
      error.status = 403;
      callback(error);
    },
  }),
);
app.use(express.json({ limit: "1mb" }));

app.use(healthRouter);

app.use(notFoundHandler);
app.use(errorHandler);
