import { z } from "zod";
import { MODULOS } from "../dominio/modulos.js";

/** Etapas da máquina de estados. "livre" = nenhuma pergunta pendente. */
export const ETAPAS = [
  "livre",
  "menu",
  "esclarecimento",
  "servico",
  "coleta_nome",
  "coleta_contato",
  "coleta_periodo",
  "confirmacao",
  "assunto_humano",
  "oferta_humano",
  "confirmar_cancelamento",
] as const;
export type Etapa = (typeof ETAPAS)[number];

const opcao = z.object({ numero: z.number().int().positive(), valor: z.string(), rotulo: z.string() });

const pergunta = z.object({
  /** Identificador crescente por conversa; ações interativas carregam esse id e são validadas contra ele. */
  id: z.number().int().positive(),
  tipo: z.enum(["opcoes", "texto"]),
  opcoes: z.array(opcao),
});

const passo = z.object({
  etapa: z.enum(ETAPAS),
  modulo: z.enum(MODULOS).optional(),
  candidatos: z.array(z.enum(MODULOS)).optional(),
});

export const esquemaEstado = z.object({
  versao: z.literal(1),
  etapa: z.enum(ETAPAS),
  modulo: z.enum(MODULOS).optional(),
  candidatos: z.array(z.enum(MODULOS)).optional(),
  dados: z.object({
    nome: z.string().optional(),
    preferenciaContato: z.string().optional(),
    periodo: z.string().optional(),
    horarioTexto: z.string().optional(),
  }),
  pergunta: pergunta.nullable(),
  historico: z.array(passo),
  falhas: z.number().int().min(0),
  /** Último id de pergunta emitido. Nunca diminui, nem quando o estado é reiniciado. */
  sequencia: z.number().int().min(0),
});

export type EstadoConversa = z.infer<typeof esquemaEstado>;
export type Pergunta = z.infer<typeof pergunta>;
export type Opcao = z.infer<typeof opcao>;
export type Passo = z.infer<typeof passo>;

export const estadoInicial = (sequencia = 0): EstadoConversa => ({
  versao: 1,
  etapa: "livre",
  dados: {},
  pergunta: null,
  historico: [],
  falhas: 0,
  sequencia,
});

/** Lê o estado gravado; se estiver corrompido ou em versão antiga, recomeça preservando a sequência. */
export function lerEstado(bruto: unknown): EstadoConversa {
  const r = esquemaEstado.safeParse(bruto);
  if (r.success) return r.data;
  const seq = (bruto as { sequencia?: unknown } | null)?.sequencia;
  return estadoInicial(typeof seq === "number" && seq >= 0 ? Math.floor(seq) : 0);
}

export const idAcao = (perguntaId: number, numero: number) => `p${perguntaId}:${numero}`;

export function lerIdAcao(id: string): { perguntaId: number; numero: number } | null {
  const m = /^p(\d{1,9}):(\d{1,2})$/.exec(id);
  return m ? { perguntaId: Number(m[1]), numero: Number(m[2]) } : null;
}
