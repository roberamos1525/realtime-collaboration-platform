import type { LogLevel } from "./config.js";

/** Structured JSON-lines logger with child bindings. */

const LEVEL_VALUE: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

export type LogFields = Record<string, unknown>;
export type LogSink = (line: string) => void;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(bindings: LogFields): Logger;
  readonly level: LogLevel;
}

function serializeError(err: unknown): unknown {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack?.split("\n").slice(0, 8).join("\n") };
  }
  return err;
}

const REDACTED_KEYS = new Set(["password", "token", "accessToken", "refreshToken", "authorization", "secret"]);

function redact(fields: LogFields): LogFields {
  const out: LogFields = {};
  for (const [k, v] of Object.entries(fields)) {
    if (REDACTED_KEYS.has(k)) out[k] = "[redacted]";
    else if (k === "err" || v instanceof Error) out[k] = serializeError(v);
    else out[k] = v;
  }
  return out;
}

export function createLogger(level: LogLevel, sink: LogSink = (line) => process.stdout.write(`${line}\n`), bindings: LogFields = {}): Logger {
  const threshold = LEVEL_VALUE[level];
  const write = (lvl: Exclude<LogLevel, "silent">, msg: string, fields?: LogFields): void => {
    if (LEVEL_VALUE[lvl] < threshold) return;
    const record = { time: new Date().toISOString(), level: lvl, msg, ...bindings, ...(fields ? redact(fields) : {}) };
    let line: string;
    try {
      line = JSON.stringify(record);
    } catch {
      line = JSON.stringify({ time: record.time, level: lvl, msg, note: "unserializable fields" });
    }
    sink(line);
  };
  return {
    level,
    debug: (m, f) => write("debug", m, f),
    info: (m, f) => write("info", m, f),
    warn: (m, f) => write("warn", m, f),
    error: (m, f) => write("error", m, f),
    child: (extra) => createLogger(level, sink, { ...bindings, ...extra }),
  };
}

/** Logger that records lines in memory; handy for tests. */
export function createMemoryLogger(level: LogLevel = "debug"): { logger: Logger; lines: () => Array<Record<string, unknown>> } {
  const lines: string[] = [];
  return {
    logger: createLogger(level, (l) => lines.push(l)),
    lines: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}
