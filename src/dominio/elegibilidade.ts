import { DEFINICOES, MODULOS, type ModuloId } from "./modulos.js";

/**
 * Elegibilidade por canal. Fica em código, não em configuração: a configuração do negócio pode
 * desligar um módulo habilitado, mas não consegue habilitar um módulo bloqueado.
 * Liberar um módulo exige revisão da política, atualização deste arquivo e do docs/elegibilidade-canais.md.
 */

export type CanalId = "whatsapp" | "canal_proprio";

export type Regra =
  | { status: "habilitado" }
  | { status: "bloqueado"; motivo: string; fonte: string }
  | { status: "pendente_avaliacao"; motivo: string };

export interface PerfilCanal {
  id: CanalId;
  nome: string;
  /** Respostas livres só dentro de 24h desde a última mensagem do contato; fora disso, modelo aprovado. */
  janela24h: boolean;
  /** Perfil existente apenas para simulação (não há adaptador real). */
  apenasSimulacao: boolean;
  regras: Record<ModuloId, Regra>;
}

export const POLITICA_WHATSAPP = {
  documento: "WhatsApp Business Policy",
  url: "https://business.whatsapp.com/policy",
  atualizadaEm: "2026-09-23",
  verificadaEm: "2026-10-28",
} as const;

const MMN: Regra = {
  status: "bloqueado",
  motivo: "Política do WhatsApp Business, seção 4: “Multi-level marketing” é atividade proibida.",
  fonte: `${POLITICA_WHATSAPP.url} (atualizada em ${POLITICA_WHATSAPP.atualizadaEm}, verificada em ${POLITICA_WHATSAPP.verificadaEm})`,
};

const habilitado: Regra = { status: "habilitado" };

export const PERFIS: Record<CanalId, PerfilCanal> = {
  whatsapp: {
    id: "whatsapp",
    nome: "WhatsApp (Cloud API)",
    janela24h: true,
    apenasSimulacao: false,
    regras: {
      renda_extra: MMN,
      distribuidor: MMN,
      equipe: MMN,
      produtos: {
        status: "pendente_avaliacao",
        motivo:
          "Produtos Herbalife: venda ligada a um modelo multinível e possível enquadramento em “Medical and healthcare products” " +
          "(seção 4). Fica desligado até avaliação documentada.",
      },
      nutricao: habilitado,
      personal: habilitado,
      falar_janiere: habilitado,
    },
  },
  // Perfil hipotético que preserva o mapa completo de 7 opções na simulação.
  // Não é um canal implementado; ver docs/elegibilidade-canais.md (proposta de canal próprio).
  canal_proprio: {
    id: "canal_proprio",
    nome: "Canal próprio (hipotético — só simulação)",
    janela24h: false,
    apenasSimulacao: true,
    regras: Object.fromEntries(MODULOS.map((m) => [m, habilitado])) as Record<ModuloId, Regra>,
  },
};

export interface RestricoesNegocio {
  modulosDesabilitados: readonly ModuloId[];
}

export type Avaliacao = { permitido: true } | { permitido: false; motivo: string };

export function avaliarModulo(perfil: PerfilCanal, negocio: RestricoesNegocio, modulo: ModuloId): Avaliacao {
  const regra = perfil.regras[modulo];
  if (regra.status !== "habilitado") return { permitido: false, motivo: regra.motivo };
  if (negocio.modulosDesabilitados.includes(modulo)) {
    return { permitido: false, motivo: "Desabilitado na configuração do negócio." };
  }
  return { permitido: true };
}

/** Módulos exibidos no menu deste canal, na ordem do menu de referência. */
export function modulosVisiveis(perfil: PerfilCanal, negocio: RestricoesNegocio): ModuloId[] {
  return [...MODULOS]
    .filter((m) => avaliarModulo(perfil, negocio, m).permitido)
    .sort((a, b) => DEFINICOES[a].referencia - DEFINICOES[b].referencia);
}

export function perfilDoCanal(canal: string): PerfilCanal {
  if (canal === "whatsapp" || canal === "canal_proprio") return PERFIS[canal];
  throw new Error(`Canal desconhecido: ${canal}`);
}
