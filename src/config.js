import dotenv from "dotenv";

dotenv.config();

function required(name, fallback = "") {
  const value = process.env[name] ?? fallback;
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

export const config = {
  databaseUrl: required(
    "DATABASE_URL",
    "postgresql://postgres:postgres@localhost:5432/correos?schema=public"
  ),
  smtp: {
    host: required("SMTP_HOST", "smtp.gmail.com"),
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: String(process.env.SMTP_SECURE ?? "false") === "true",
    user: required("SMTP_USER", "example@gmail.com"),
    pass: required("SMTP_PASS", "app_password")
  },
  from: {
    name: process.env.FROM_NAME ?? "Tu Marca",
    email: process.env.FROM_EMAIL ?? "news@example.com",
    replyTo: process.env.REPLY_TO ?? "reply@example.com"
  },
  freeDailyLimit: Number(process.env.FREE_DAILY_LIMIT ?? 300),
  batchSize: Number(process.env.BATCH_SIZE ?? 25),
  loopIntervalSeconds: Number(process.env.LOOP_INTERVAL_SECONDS ?? 20),
  unsubscribeBaseUrl: process.env.UNSUBSCRIBE_BASE_URL ?? "http://localhost:3000",
  webhookPort: Number(process.env.WEBHOOK_PORT ?? 3000)
};
