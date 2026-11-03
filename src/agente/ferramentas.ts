import type { BetaTool } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { z } from "zod";
import type { ConfigNegocio } from "../config/negocio.js";
import { temasNaoPermitidos } from "../conversa/intencoes.js";
import { extrairNome } from "../conversa/motor.js";
import { foraDoExpediente } from "../conversa/textos.js";
import type { Cliente } from "../db/pool.js";
import { avaliarModulo, type PerfilCanal } from "../dominio/elegibilidade.js";
import { DEFINICOES, MODULOS, SERVICOS_PROFISSIONAIS } from "../dominio/modulos.js";
import { normalizar } from "../lib/texto.js";
import { abrirAtendimento, registrarSolicitacaoAgendamento } from "../nucleo/persistencia.js";

/**
 * Ferramentas da IA. A identidade do contato e da conversa vem do servidor (AlvoFerramenta),
 * nunca da entrada da ferramenta. Toda entrada é revalidada aqui, inclusive a elegibilidade
 * no canal, mesmo com o esquema estrito no lado do modelo.
 */

export interface AlvoFerramenta {
  c: Cliente;
  negocio: ConfigNegocio;
  perfil: PerfilCanal;
  contatoId: string;
  conversaId: string;
  agora: Date;
  /** Acumulado do turno: o núcleo usa para decidir o que fazer depois da resposta. */
  turno: { mostrarMenu: boolean; atendimentoAberto: boolean; solicitacoes: number };
}

export interface ResultadoFerramenta {
  erro: boolean;
  conteudo: Record<string, unknown>;
}

const servicosPermitidos = (perfil: PerfilCanal, negocio: ConfigNegocio) =>
  SERVICOS_PROFISSIONAIS.filter((s) => avaliarModulo(perfil, negocio, s).permitido);

export function definirFerramentas(perfil: PerfilCanal, negocio: ConfigNegocio): BetaTool[] {
  const ferramentas: BetaTool[] = [];
  const servicos = servicosPermitidos(perfil, negocio);
  if (servicos.length) {
    ferramentas.push({
      name: "registrar_solicitacao_atendimento",
      description:
        "Registra o pedido da pessoa para que a Janiere entre em contato e combine o horário de um serviço. " +
        "Use quando a pessoa quiser ser contatada e já tiver informado o serviço, o nome e a preferência de contato. " +
        "Não confirma data nem horário.",
      strict: true,
      input_schema: {
        type: "object",
        properties: {
          servico: {
            type: "string",
            enum: servicos,
            description: servicos.map((s) => `${s} = ${DEFINICOES[s].titulo}`).join("; "),
          },
          nome: { type: "string", description: "Nome como a pessoa informou" },
          preferencia_contato: { type: "string", enum: negocio.preferenciasContato.map((o) => o.valor) },
          periodo: {
            anyOf: [{ type: "string", enum: negocio.periodos.map((o) => o.valor) }, { type: "null" }],
            description: "Período preferido, se a pessoa informou",
          },
          horario_texto: {
            anyOf: [{ type: "string" }, { type: "null" }],
            description: "Preferência de horário em texto livre, se não couber nos períodos (ex.: depois das 18h)",
          },
        },
        required: ["servico", "nome", "preferencia_contato", "periodo", "horario_texto"],
        additionalProperties: false,
      },
    });
  }
  ferramentas.push(
    {
      name: "solicitar_atendimento_humano",
      description:
        "Pede que a Janiere ou a equipe responda pessoalmente esta conversa e pausa as respostas automáticas. " +
        "Use quando a pessoa pedir para falar com a Janiere ou com uma pessoa, reclamar, ou quando você não conseguir ajudar.",
      strict: true,
      input_schema: {
        type: "object",
        properties: { motivo: { type: "string", description: "Resumo do assunto em uma frase" } },
        required: ["motivo"],
        additionalProperties: false,
      },
    },
    {
      name: "mostrar_menu",
      description: "Envia, logo depois da sua resposta, o menu numerado com as opções deste canal.",
      strict: true,
      input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
    },
  );
  return ferramentas;
}

const entradaSolicitacao = z.object({
  servico: z.enum(SERVICOS_PROFISSIONAIS),
  nome: z.string(),
  preferencia_contato: z.string(),
  periodo: z.string().nullable(),
  horario_texto: z.string().nullable(),
});
const entradaHumano = z.object({ motivo: z.string().trim().min(2).max(300) });

const erro = (mensagem: string): ResultadoFerramenta => ({ erro: true, conteudo: { erro: mensagem } });

export async function executarFerramenta(nome: string, entrada: unknown, alvo: AlvoFerramenta): Promise<ResultadoFerramenta> {
  switch (nome) {
    case "registrar_solicitacao_atendimento":
      return registrarSolicitacao(entrada, alvo);
    case "solicitar_atendimento_humano":
      return solicitarHumano(entrada, alvo);
    case "mostrar_menu":
      alvo.turno.mostrarMenu = true;
      return { erro: false, conteudo: { ok: true, observacao: "O menu será enviado logo depois da sua resposta." } };
    default:
      return erro(`Ferramenta desconhecida: ${nome}`);
  }
}

async function registrarSolicitacao(bruta: unknown, alvo: AlvoFerramenta): Promise<ResultadoFerramenta> {
  const r = entradaSolicitacao.safeParse(bruta);
  if (!r.success) return erro("Entrada inválida para registrar_solicitacao_atendimento.");
  const e = r.data;
  const { negocio, perfil } = alvo;
  if (!servicosPermitidos(perfil, negocio).includes(e.servico)) return erro("Serviço indisponível neste canal.");
  const nome = extrairNome(e.nome);
  if (!nome) return erro("Nome inválido. Peça à pessoa como ela gostaria de ser chamada.");
  if (!negocio.preferenciasContato.some((o) => o.valor === e.preferencia_contato)) return erro("Preferência de contato inválida.");
  if (e.periodo !== null && !negocio.periodos.some((o) => o.valor === e.periodo)) return erro("Período inválido.");
  const horarioTexto = e.horario_texto?.trim().slice(0, 80) || null;
  if (horarioTexto && temasNaoPermitidos(normalizar(horarioTexto), perfil, negocio).length) return erro("Horário inválido.");

  const { jaExistia } = await registrarSolicitacaoAgendamento(alvo.c, {
    contatoId: alvo.contatoId,
    conversaId: alvo.conversaId,
    modulo: e.servico,
    dados: { nome, preferenciaContato: e.preferencia_contato, periodo: e.periodo, horarioTexto },
    agora: alvo.agora,
    ator: "agente",
  });
  alvo.turno.solicitacoes += 1;
  return {
    erro: false,
    conteudo: {
      ok: true,
      situacao: jaExistia ? "solicitacao_existente_atualizada" : "solicitacao_registrada",
      proximo_passo: "A Janiere entra em contato pelo meio escolhido para combinar o horário. Nenhum horário está confirmado.",
      prazo_retorno: negocio.atendimentoHumano.prazoRetorno,
    },
  };
}

async function solicitarHumano(bruta: unknown, alvo: AlvoFerramenta): Promise<ResultadoFerramenta> {
  const r = entradaHumano.safeParse(bruta);
  if (!r.success) return erro("Informe o motivo em uma frase.");
  const { negocio, perfil } = alvo;
  // O atendimento humano segue as mesmas restrições do canal.
  if (temasNaoPermitidos(normalizar(r.data.motivo), perfil, negocio).length) {
    return erro("Esse assunto não é atendido neste canal: não abra atendimento. Diga apenas que não é atendido por aqui.");
  }
  if (!alvo.turno.atendimentoAberto) {
    const restritos = MODULOS.filter((m) => !avaliarModulo(perfil, negocio, m).permitido);
    await abrirAtendimento(alvo.c, negocio, {
      conversaId: alvo.conversaId,
      contatoId: alvo.contatoId,
      origem: "agente",
      motivo: r.data.motivo,
      resumo: [
        `Canal: ${perfil.nome}`,
        "Aberto pela assistente virtual (IA). O histórico completo está na conversa.",
        restritos.length
          ? `Restrições deste canal (valem também para o atendimento humano): não tratar ${restritos.map((m) => DEFINICOES[m].titulo).join("; ")}`
          : null,
      ]
        .filter(Boolean)
        .join("\n"),
      agora: alvo.agora,
    });
    alvo.turno.atendimentoAberto = true;
  }
  return {
    erro: false,
    conteudo: {
      ok: true,
      respostas_automaticas: "pausadas até a equipe responder",
      fora_do_expediente: foraDoExpediente(negocio, alvo.agora),
      prazo_retorno: negocio.atendimentoHumano.prazoRetorno,
    },
  };
}
