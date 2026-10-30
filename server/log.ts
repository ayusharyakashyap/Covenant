// Structured JSON logs (one line per event) for any log pipeline (Render, Datadog, Loki).
// Secrets are never logged: keys, invite codes and file contents stay out of log lines.
type Fields = Record<string, unknown>;
const pretty = process.env.LOG_FORMAT === "pretty" || (process.stdout.isTTY && process.env.NODE_ENV !== "production");

function write(level: "info" | "warn" | "error", msg: string, fields: Fields = {}) {
  if (process.env.LOG_LEVEL === "silent") return;
  if (pretty) {
    const extra = Object.entries(fields).map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`).join(" ");
    (level === "error" ? console.error : console.log)(`${level === "info" ? "·" : level === "warn" ? "!" : "✗"} ${msg} ${extra}`);
    return;
  }
  process.stdout.write(JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields }) + "\n");
}

export const log = {
  info: (msg: string, f?: Fields) => write("info", msg, f),
  warn: (msg: string, f?: Fields) => write("warn", msg, f),
  error: (msg: string, f?: Fields) => write("error", msg, f),
};
