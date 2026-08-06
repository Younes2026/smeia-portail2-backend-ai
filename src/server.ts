import { app } from "./app.js";
import { env } from "./config/env.js";

const server = app.listen(env.PORT, () => {
  console.log(`SMEIA AI backend listening on port ${env.PORT}.`);
});

server.on("error", () => {
  console.error("The SMEIA AI backend could not start.");
  process.exitCode = 1;
});

const shutdown = () => {
  server.close(() => {
    process.exit(0);
  });
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
