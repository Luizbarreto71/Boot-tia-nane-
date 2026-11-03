import type { ConfigAgente } from "./agente/agente.js";
import { criarClienteAnthropic } from "./agente/modelo.js";
import { AdaptadorSimulacao } from "./canais/simulacao.js";
import type { EnvioSaida } from "./canais/tipos.js";
import { AdaptadorWhatsApp, type ConfigWhatsApp } from "./canais/whatsapp.js";
import type { Ambiente } from "./config/env.js";
import { carregarNegocio } from "./config/negocio.js";
import { criarPool } from "./db/pool.js";
import { criarLogger, type Logger } from "./lib/log.js";
import type { Dependencias } from "./nucleo/dependencias.js";

export interface Aplicacao {
  deps: Dependencias;
  /** Presente fora da simulação. */
  whatsapp: ConfigWhatsApp | null;
  encerrar(): Promise<void>;
}

/** Monta as dependências do núcleo a partir do ambiente validado. */
export function montarAplicacao(opcoes: {
  env: Ambiente;
  relogio?: () => Date;
  aoEnviarSimulado?: (envio: EnvioSaida) => void;
  log?: Logger;
}): Aplicacao {
  const { env } = opcoes;
  const log =
    opcoes.log ??
    criarLogger({
      nivel: env.LOG_LEVEL,
      segredos: [
        env.META_APP_SECRET,
        env.WHATSAPP_ACCESS_TOKEN,
        env.WHATSAPP_VERIFY_TOKEN,
        env.ANTHROPIC_API_KEY,
        senhaDaUrl(env.DATABASE_URL),
      ],
    });
  const negocio = carregarNegocio(env.BUSINESS_CONFIG_PATH, { simulacao: env.SIMULATION_MODE });
  const pool = criarPool(env.DATABASE_URL);
  pool.on("error", (e) => log.error("erro no pool do banco", { erro: e }));

  // A validação do ambiente garante essas variáveis quando SIMULATION_MODE=false.
  const whatsapp: ConfigWhatsApp | null = env.SIMULATION_MODE
    ? null
    : {
        tokenAcesso: env.WHATSAPP_ACCESS_TOKEN!,
        idNumero: env.WHATSAPP_PHONE_NUMBER_ID!,
        versaoGraph: env.GRAPH_API_VERSION!,
        segredoApp: env.META_APP_SECRET!,
        tokenVerificacao: env.WHATSAPP_VERIFY_TOKEN!,
      };

  const agente: ConfigAgente | null =
    env.AGENT_ENABLED && env.ANTHROPIC_API_KEY
      ? { cliente: criarClienteAnthropic(env.ANTHROPIC_API_KEY), modelo: env.ANTHROPIC_MODEL, esforco: env.AI_EFFORT }
      : null;

  const deps: Dependencias = {
    pool,
    negocio,
    adaptadores: whatsapp
      ? { whatsapp: new AdaptadorWhatsApp(whatsapp) }
      : {
          whatsapp: new AdaptadorSimulacao("whatsapp", opcoes.aoEnviarSimulado),
          canal_proprio: new AdaptadorSimulacao("canal_proprio", opcoes.aoEnviarSimulado),
        },
    relogio: opcoes.relogio ?? (() => new Date()),
    simulacao: env.SIMULATION_MODE,
    log,
    agente,
  };
  return { deps, whatsapp, encerrar: () => pool.end() };
}

function senhaDaUrl(url: string): string | undefined {
  try {
    return decodeURIComponent(new URL(url).password) || undefined;
  } catch {
    return undefined;
  }
}
