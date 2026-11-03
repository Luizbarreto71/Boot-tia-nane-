import type { ConfigAgente } from "../agente/agente.js";
import type { AdaptadorCanal } from "../canais/tipos.js";
import type { ConfigNegocio } from "../config/negocio.js";
import type { Pool } from "../db/pool.js";
import type { CanalId } from "../dominio/elegibilidade.js";
import type { Logger } from "../lib/log.js";

export interface Dependencias {
  pool: Pool;
  negocio: ConfigNegocio;
  adaptadores: Partial<Record<CanalId, AdaptadorCanal>>;
  relogio: () => Date;
  /** Quando true, toda mensagem gravada fica marcada como simulada e só o adaptador de simulação a aceita. */
  simulacao: boolean;
  log: Logger;
  /** Agente de IA para texto livre. null = só o motor de menus. */
  agente?: ConfigAgente | null;
}
