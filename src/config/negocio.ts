import { readFileSync } from "node:fs";
import { z } from "zod";
import { MODULOS } from "../dominio/modulos.js";

/**
 * Configuração controlada do negócio: serviços, preços, horários e responsáveis.
 * Um dado só é apresentado ao contato quando tem revisão registrada (quem aprovou, quando, fonte),
 * ou quando o arquivo inteiro é demonstrativo — e nesse caso a resposta sai marcada como tal.
 */

const revisao = z.object({
  aprovadoPor: z.string().min(1),
  data: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  fonte: z.string().min(1),
});

const servico = z.object({
  titulo: z.string().min(1),
  formato: z.string().min(1).nullable(),
  preco: z
    .object({ valorCentavos: z.number().int().positive(), observacao: z.string().min(1).optional() })
    .nullable(),
  revisao: revisao.nullable(),
});

const opcao = z.object({
  valor: z.string().regex(/^[a-z_]+$/),
  rotulo: z.string().min(1).max(20),
  aliases: z.array(z.string().min(1)).default([]),
});

const hora = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

export const esquemaNegocio = z.object({
  demonstrativo: z.boolean(),
  profissional: z.object({ nome: z.string().min(1), apresentacao: z.string().min(1) }),
  modulosDesabilitados: z.array(z.enum(MODULOS)).default([]),
  servicos: z.object({ nutricao: servico, personal: servico }),
  atendimentoHumano: z.object({
    /** chave do operador que recebe as solicitações por padrão (tabela operadores). */
    responsavelPadrao: z.string().min(1).nullable(),
    /** dias 0=domingo … 6=sábado, no fuso America/Sao_Paulo. null = não informar expediente. */
    expediente: z
      .object({ diasSemana: z.array(z.number().int().min(0).max(6)).min(1), inicio: hora, fim: hora })
      .nullable(),
    /** Texto aprovado, ex.: "em até 1 dia útil". null = não prometer prazo. */
    prazoRetorno: z.string().min(1).nullable(),
  }),
  preferenciasContato: z.array(opcao).min(1).max(10),
  periodos: z.array(opcao).min(1).max(10),
  /** Perguntas frequentes com resposta aprovada. Só entram no contexto da IA com revisão (ou em arquivo demonstrativo). */
  conhecimento: z
    .array(z.object({ pergunta: z.string().min(1), resposta: z.string().min(1), revisao: revisao.nullable() }))
    .default([]),
});

export type ConfigNegocio = z.infer<typeof esquemaNegocio>;
export type ConfigServico = z.infer<typeof servico>;

export function validarNegocio(dados: unknown, opcoes: { simulacao: boolean }): ConfigNegocio {
  const r = esquemaNegocio.safeParse(dados);
  if (!r.success) {
    const problemas = r.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Configuração do negócio inválida:\n${problemas}`);
  }
  if (r.data.demonstrativo && !opcoes.simulacao) {
    throw new Error("A configuração demonstrativa só pode ser usada em modo de simulação.");
  }
  return r.data;
}

export function carregarNegocio(caminho: string, opcoes: { simulacao: boolean }): ConfigNegocio {
  return validarNegocio(JSON.parse(readFileSync(caminho, "utf8")), opcoes);
}

/** Um campo do serviço pode ser mostrado? (aprovado, ou arquivo demonstrativo) */
export const servicoApresentavel = (negocio: ConfigNegocio, s: ConfigServico) => negocio.demonstrativo || s.revisao !== null;
