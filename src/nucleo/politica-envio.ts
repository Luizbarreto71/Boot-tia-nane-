import type { ConfigNegocio } from "../config/negocio.js";
import { temasNaoPermitidos } from "../conversa/intencoes.js";
import { avaliarModulo, type PerfilCanal } from "../dominio/elegibilidade.js";
import { DEFINICOES, type ModuloId } from "../dominio/modulos.js";
import { normalizar } from "../lib/texto.js";

/**
 * Política de envio, aplicada a TODA saída — bot, resposta humana e tarefa agendada —
 * no momento de enfileirar (para dar retorno imediato) e de novo no despacho.
 */

export const JANELA_ATENDIMENTO_MS = 24 * 60 * 60 * 1000;

export type Origem = "bot" | "operador" | "tarefa";

export interface PedidoEnvio {
  origem: Origem;
  modulo: ModuloId | null;
  texto: string;
}

export interface SituacaoContato {
  ultimaMensagemContatoEm: Date | null;
  /** Consentimento vigente para acompanhamentos (exigido em envios proativos). */
  consentimentoAcompanhamento: boolean;
}

export type CodigoBloqueio = "modulo_bloqueado" | "tema_bloqueado" | "sem_consentimento" | "fora_janela";

export type Decisao = { permitido: true } | { permitido: false; codigo: CodigoBloqueio; motivo: string };

export function avaliarEnvio(
  perfil: PerfilCanal,
  negocio: ConfigNegocio,
  situacao: SituacaoContato,
  pedido: PedidoEnvio,
  agora: Date,
): Decisao {
  if (pedido.modulo) {
    const av = avaliarModulo(perfil, negocio, pedido.modulo);
    if (!av.permitido) return { permitido: false, codigo: "modulo_bloqueado", motivo: av.motivo };
  }
  const temas = temasNaoPermitidos(normalizar(pedido.texto), perfil, negocio);
  if (temas.length) {
    return {
      permitido: false,
      codigo: "tema_bloqueado",
      motivo: `Assunto não permitido em ${perfil.nome}: ${temas.map((m) => DEFINICOES[m].titulo).join("; ")}.`,
    };
  }
  if (pedido.origem === "tarefa" && !situacao.consentimentoAcompanhamento) {
    return { permitido: false, codigo: "sem_consentimento", motivo: "Envio proativo sem consentimento vigente." };
  }
  if (perfil.janela24h) {
    const ultima = situacao.ultimaMensagemContatoEm;
    const dentro = ultima !== null && agora.getTime() - ultima.getTime() < JANELA_ATENDIMENTO_MS;
    if (!dentro) {
      // Modelos aprovados (templates) entram na etapa 3; até lá, fora da janela nada pode sair.
      return {
        permitido: false,
        codigo: "fora_janela",
        motivo: "Fora da janela de 24h desde a última mensagem do contato; só um modelo aprovado poderia ser enviado e ainda não há modelos cadastrados.",
      };
    }
  }
  return { permitido: true };
}
