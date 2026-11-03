import { existsSync } from "node:fs";
import { z } from "zod";

const booleano = z.enum(["true", "false"]).transform((v) => v === "true");
const opcional = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === "" ? undefined : v.trim()));

const esquema = z
  .object({
    DATABASE_URL: z.string().min(1, "obrigatória"),
    SIMULATION_MODE: booleano.default(true),
    BUSINESS_CONFIG_PATH: z.string().default("config/negocio.demo.json"),
    TIMEZONE: z.literal("America/Sao_Paulo").default("America/Sao_Paulo"),
    FOLLOWUPS_ENABLED: booleano.default(false),
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    /** Agente de IA: ativo quando há ANTHROPIC_API_KEY e AGENT_ENABLED não é false. */
    AGENT_ENABLED: booleano.default(true),
    ANTHROPIC_API_KEY: opcional,
    ANTHROPIC_MODEL: opcional.transform((v) => v ?? "claude-opus-5-5"),
    AI_EFFORT: z.enum(["low", "medium", "high"]).default("low"),
    META_APP_SECRET: opcional,
    WHATSAPP_VERIFY_TOKEN: opcional,
    WHATSAPP_ACCESS_TOKEN: opcional,
    WHATSAPP_PHONE_NUMBER_ID: opcional,
    WHATSAPP_BUSINESS_ACCOUNT_ID: opcional,
    GRAPH_API_VERSION: opcional.pipe(z.string().regex(/^v\d+\.\d+$/, "formato vNN.N").optional()),
    PUBLIC_BASE_URL: opcional.pipe(z.url().optional()),
  })
  .superRefine((e, ctx) => {
    if (e.FOLLOWUPS_ENABLED) {
      ctx.addIssue({
        code: "custom",
        path: ["FOLLOWUPS_ENABLED"],
        message: "acompanhamentos ainda não implementados (etapa 4); mantenha false",
      });
    }
    if (!e.SIMULATION_MODE) {
      const exigidas = [
        "META_APP_SECRET",
        "WHATSAPP_VERIFY_TOKEN",
        "WHATSAPP_ACCESS_TOKEN",
        "WHATSAPP_PHONE_NUMBER_ID",
        "WHATSAPP_BUSINESS_ACCOUNT_ID",
        "GRAPH_API_VERSION",
        "PUBLIC_BASE_URL",
      ] as const;
      for (const chave of exigidas) {
        if (!e[chave]) ctx.addIssue({ code: "custom", path: [chave], message: "obrigatória quando SIMULATION_MODE=false" });
      }
    }
  });

export type Ambiente = z.infer<typeof esquema>;

/** Lê e valida o ambiente. A mensagem de erro cita apenas nomes de variáveis, nunca valores. */
export function carregarAmbiente(fonte: NodeJS.ProcessEnv = process.env): Ambiente {
  if (fonte === process.env && existsSync(".env")) process.loadEnvFile(".env");
  const r = esquema.safeParse(fonte);
  if (!r.success) {
    const problemas = r.error.issues.map((i) => `  - ${i.path.join(".") || "(raiz)"}: ${i.message}`).join("\n");
    throw new Error(`Configuração de ambiente inválida:\n${problemas}`);
  }
  return r.data;
}
