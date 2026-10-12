import express from "express";
import pino from "pino";
import { ordersRouter } from "./routes/orders.js";
import { authRouter } from "./routes/auth.js";
import { customersRouter } from "./routes/customers.js";
import { webhooksRouter } from "./routes/webhooks.js";
import { requireAuth } from "./middleware/auth.js";
import { env } from "./config.js";

export const log = pino({ level: env.LOG_LEVEL });

export function createApp() {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.get("/healthz", (_req, res) => res.json({ ok: true, version: "3.4.1" }));

  app.use("/auth", authRouter);
  // Webhooks are authenticated by signature, not by user JWT.
  app.use("/webhooks", webhooksRouter);

  app.use("/orders", requireAuth, ordersRouter);
  app.use("/customers", requireAuth, customersRouter);

  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    log.error({ err }, "unhandled error");
    res.status(500).json({ error: "internal_error" });
  });

  return app;
}

if (process.env.NODE_ENV !== "test") {
  const app = createApp();
  app.listen(env.PORT, () => log.info({ port: env.PORT }, "ledgerly-api listening"));
}
