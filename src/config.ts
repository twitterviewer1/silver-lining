import dotenv from "dotenv";
dotenv.config();

const isDev = process.env.NODE_ENV !== "production";

type PromptLoggingBackend = "google_sheets";
export type DequeueMode = "fair" | "random" | "none";

type Config = {
  /** The port the proxy server will listen on. */
  port: number;
  /** OpenAI API key, either a single key or a comma-delimeted list of keys. */
  openaiKey?: string;
  /** Proxy key. If set, requests must provide this key in the Authorization header to use the proxy. */
  proxyKey?: string;
  /** Per-IP limit for requests per minute to OpenAI's completions endpoint. */
  modelRateLimit: number;
  /** Max number of tokens to generate. Requests which specify a higher value will be rewritten to use this value. */
  maxOutputTokens: number;
  /** Whether requests containing disallowed characters should be rejected. */
  rejectDisallowed?: boolean;
  /** Rejection sample rate (0 - 1). Higher values are more strict but increase server load. */
  rejectSampleRate?: number;
  /** Message to return when rejecting requests. */
  rejectMessage?: string;
  /** Pino log level. */
  logLevel?: "debug" | "info" | "warn" | "error";
  /** Whether prompts and responses should be logged to persistent storage. */
  promptLogging?: boolean;
  /** Which prompt logging backend to use. */
  promptLoggingBackend?: PromptLoggingBackend;
  /** Base64-encoded Google Sheets API key. */
  googleSheetsKey?: string;
  /** Google Sheets spreadsheet ID. */
  googleSheetsSpreadsheetId?: string;
  /** Whether to periodically check keys for usage and validity. */
  checkKeys?: boolean;
  /**
   * How to display quota information on the info page.
   * 'none' - Hide quota information
   * 'simple' - Display quota information as a percentage
   * 'full' - Display quota information as usage against total capacity
   */
  quotaDisplayMode: "none" | "simple" | "full";
  /**
   * Which request queueing strategy to use when keys are over their rate limit.
   * 'fair' - Requests are serviced in the order they were received (default)
   * 'random' - Requests are serviced randomly
   * 'none' - Requests are not queued and users have to retry manually
   */
  queueMode: DequeueMode;
};

// To change configs, create a file called .env in the root directory.
// See .env.example for an example.
export const config: Config = {
  port: getEnvWithDefault("PORT", 7860),
  openaiKey: getEnvWithDefault("OPENAI_KEY", ""),
  proxyKey: getEnvWithDefault("PROXY_KEY", ""),
  modelRateLimit: getEnvWithDefault("MODEL_RATE_LIMIT", 4),
  maxOutputTokens: getEnvWithDefault("MAX_OUTPUT_TOKENS", 300),
  rejectDisallowed: getEnvWithDefault("REJECT_DISALLOWED", false),
  rejectSampleRate: getEnvWithDefault("REJECT_SAMPLE_RATE", 0.2),
  rejectMessage: getEnvWithDefault(
    "REJECT_MESSAGE",
    "This content violates /aicg/'s acceptable use policy."
  ),
  logLevel: getEnvWithDefault("LOG_LEVEL", "info"),
  checkKeys: getEnvWithDefault("CHECK_KEYS", !isDev),
  quotaDisplayMode: getEnvWithDefault("QUOTA_DISPLAY_MODE", "full"),
  promptLogging: getEnvWithDefault("PROMPT_LOGGING", false),
  promptLoggingBackend: getEnvWithDefault("PROMPT_LOGGING_BACKEND", undefined),
  googleSheetsKey: getEnvWithDefault("GOOGLE_SHEETS_KEY", undefined),
  googleSheetsSpreadsheetId: getEnvWithDefault(
    "GOOGLE_SHEETS_SPREADSHEET_ID",
    undefined
  ),
  queueMode: getEnvWithDefault("QUEUE_MODE", "fair"),
} as const;

export const SENSITIVE_KEYS: (keyof Config)[] = [
  "proxyKey",
  "openaiKey",
  "googleSheetsKey",
  "googleSheetsSpreadsheetId",
];
const getKeys = Object.keys as <T extends object>(obj: T) => Array<keyof T>;
export function listConfig(): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of getKeys(config)) {
    const value = config[key]?.toString() || "";
    
    if (value === "" || value === "undefined") {
      continue;
    }
    
    if (value && SENSITIVE_KEYS.includes(key)) {
      result[key] = "********";
    } else {
      result[key] = value;
    }
  }
  return result;
}

function getEnvWithDefault<T>(name: string, defaultValue: T): T {
  const value = process.env[name];
  if (value === undefined) {
    return defaultValue;
  }
  try {
    if (name === "OPENAI_KEY") {
      return value as unknown as T;
    }
    return JSON.parse(value) as T;
  } catch (err) {
    return value as unknown as T;
  }
}
