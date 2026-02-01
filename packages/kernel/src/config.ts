import { z } from "zod";

const kernelConfigSchema = z.object({
  gateway: z.object({
    port: z.number().default(18800),
    host: z.string().default("127.0.0.1"),
    token: z.string().optional(),
  }).default({}),
  database: z.object({
    url: z.string().default("postgresql://localhost:5432/agent_os"),
  }).default({}),
  redis: z.object({
    url: z.string().default("redis://localhost:6379"),
  }).default({}),
  logging: z.object({
    level: z.enum(["debug", "info", "warn", "error"]).default("info"),
  }).default({}),
});

export type KernelConfig = z.infer<typeof kernelConfigSchema>;

/** Creates and validates kernel configuration from env/file */
export function createConfig(overrides?: Partial<KernelConfig>): KernelConfig {
  return kernelConfigSchema.parse({
    gateway: {
      port: Number(process.env.GATEWAY_PORT) || overrides?.gateway?.port,
      host: process.env.GATEWAY_HOST || overrides?.gateway?.host,
      token: process.env.GATEWAY_TOKEN || overrides?.gateway?.token,
    },
    database: {
      url: process.env.DATABASE_URL || overrides?.database?.url,
    },
    redis: {
      url: process.env.REDIS_URL || overrides?.redis?.url,
    },
    logging: {
      level: (process.env.LOG_LEVEL as KernelConfig["logging"]["level"]) || overrides?.logging?.level,
    },
  });
}
