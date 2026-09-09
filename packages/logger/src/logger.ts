import pino from "pino";
import type { DestinationStream, Level, Logger } from "pino";

import { redactText, redactValue } from "./redact";

export interface ForgeDeckLogger {
  debug(message: string, context?: unknown): void;
  info(message: string, context?: unknown): void;
  warn(message: string, context?: unknown): void;
  error(message: string, context?: unknown): void;
}

export interface CreateLoggerOptions {
  readonly level?: Level;
  readonly destination?: DestinationStream;
}

export function createLogger(options: CreateLoggerOptions = {}): ForgeDeckLogger {
  const logger = pino(
    {
      level: options.level ?? "info",
      base: null
    },
    options.destination
  );

  return {
    debug: createLogMethod(logger, "debug"),
    info: createLogMethod(logger, "info"),
    warn: createLogMethod(logger, "warn"),
    error: createLogMethod(logger, "error")
  };
}

function createLogMethod(
  logger: Logger,
  level: "debug" | "info" | "warn" | "error"
): (message: string, context?: unknown) => void {
  return (message, context) => {
    if (context === undefined) {
      logger[level](redactText(message));
      return;
    }
    logger[level]({ context: redactValue(context) }, redactText(message));
  };
}
