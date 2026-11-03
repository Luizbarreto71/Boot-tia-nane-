import { estadoInicial, lerEstado } from "../conversa/estado.js";
import { emTransacao, type Cliente } from "../db/pool.js";
import { perfilDoCanal, type CanalId } from "../dominio/elegibilidade.js";
import type { Dependencias } from "./dependencias.js";
import { despacharPendentes } from "./envio.js";
import { abrirAtendimento, auditar, enfileirarSaida } from "./persistencia.js";
import { avaliarEnvio, type CodigoBloqueio } from "./politica-envio.js";

/**
 * Operação humana: assumir, responder e devolver ao bot. Toda ação exige operador ativo;
 * responder e devolver exigem ser a pessoa responsável (ou admin). Respostas humanas passam
 * pela mesma política de envio do bot (janela de 24h e restrições do canal).
 */

export class ErroPermissao extends Error {
  override name = "ErroPermissao";
}
export class ErroAtendimento extends Error {
  override name = "ErroAtendimento";
}
export class ErroEnvioBloqueado extends Error {
  override name = "ErroEnvioBloqueado";
  constructor(
    readonly codigo: CodigoBloqueio,
    mensagem: string,
  ) {
    super(mensagem);
  }
}

interface Operador {
  id: string;
  nome: string;
  papel: "admin" | "atendente";
}

interface ConversaTravada {
  id: string;
  contato_id: string;
  canal: CanalId;
  estado: unknown;
  ultima_mensagem_contato_em: Date | null;
}

interface AtendimentoAberto {
  id: string;
  status: "solicitado" | "em_atendimento";
  responsavel_id: string | null;
}

async function operadorAtivo(c: Cliente, operadorId: string): Promise<Operador> {
  const r = await c.query<Operador & { ativo: boolean }>(
    "select id, nome, papel, ativo from operadores where id = $1",
    [operadorId],
  );
  const op = r.rows[0];
  if (!op || !op.ativo) throw new ErroPermissao("Operador inexistente ou inativo.");
  return op;
}

async function travarConversa(c: Cliente, conversaId: string): Promise<ConversaTravada> {
  const r = await c.query<ConversaTravada>(
    "select id, contato_id, canal, estado, ultima_mensagem_contato_em from conversas where id = $1 for update",
    [conversaId],
  );
  if (!r.rows[0]) throw new ErroAtendimento("Conversa não encontrada.");
  return r.rows[0];
}

async function atendimentoAberto(c: Cliente, conversaId: string): Promise<AtendimentoAberto | null> {
  const r = await c.query<AtendimentoAberto>(
    `select id, status, responsavel_id from atendimentos
     where conversa_id = $1 and status in ('solicitado', 'em_atendimento') for update`,
    [conversaId],
  );
  return r.rows[0] ?? null;
}

const podeAgir = (op: Operador, at: AtendimentoAberto) => op.papel === "admin" || at.responsavel_id === op.id;

export async function assumirAtendimento(
  deps: Dependencias,
  a: { conversaId: string; operadorId: string },
): Promise<{ atendimentoId: string }> {
  const agora = deps.relogio();
  return emTransacao(deps.pool, async (c) => {
    const op = await operadorAtivo(c, a.operadorId);
    const conversa = await travarConversa(c, a.conversaId);
    let at = await atendimentoAberto(c, conversa.id);
    if (!at) {
      await abrirAtendimento(c, deps.negocio, {
        conversaId: conversa.id,
        contatoId: conversa.contato_id,
        origem: "operador",
        motivo: "Atendimento assumido por iniciativa da equipe",
        resumo: `Canal: ${perfilDoCanal(conversa.canal).nome}`,
        agora,
        responsavelId: op.id,
      });
      at = (await atendimentoAberto(c, conversa.id))!;
    }
    if (at.status === "em_atendimento" && !podeAgir(op, at)) {
      throw new ErroPermissao("Este atendimento já está com outra pessoa; só um admin pode transferir.");
    }
    await c.query(
      "update atendimentos set status = 'em_atendimento', responsavel_id = $2, assumido_em = coalesce(assumido_em, $3) where id = $1",
      [at.id, op.id, agora],
    );
    await auditar(c, {
      atorTipo: "operador",
      atorId: op.id,
      acao: "atendimento_assumido",
      entidade: "atendimento",
      entidadeId: at.id,
      detalhes: { responsavelAnterior: at.responsavel_id },
    });
    return { atendimentoId: at.id };
  });
}

export async function responderComoOperador(
  deps: Dependencias,
  a: { conversaId: string; operadorId: string; texto: string },
): Promise<{ mensagemId: string }> {
  const texto = a.texto.trim();
  if (!texto) throw new ErroAtendimento("Mensagem vazia.");
  if (texto.length > 4096) throw new ErroAtendimento("Mensagem acima de 4096 caracteres.");
  const agora = deps.relogio();

  type Retorno = { mensagemId: string } | { bloqueio: { codigo: CodigoBloqueio; motivo: string } };
  const r = await emTransacao(deps.pool, async (c): Promise<Retorno> => {
    const op = await operadorAtivo(c, a.operadorId);
    const conversa = await travarConversa(c, a.conversaId);
    const at = await atendimentoAberto(c, conversa.id);
    if (!at || at.status !== "em_atendimento") throw new ErroAtendimento("Assuma o atendimento antes de responder.");
    if (!podeAgir(op, at)) throw new ErroPermissao("Só a pessoa responsável (ou um admin) responde neste atendimento.");

    const decisao = avaliarEnvio(
      perfilDoCanal(conversa.canal),
      deps.negocio,
      { ultimaMensagemContatoEm: conversa.ultima_mensagem_contato_em, consentimentoAcompanhamento: false },
      { origem: "operador", modulo: null, texto },
      agora,
    );
    if (!decisao.permitido) {
      // A tentativa bloqueada fica auditada (commit) e o erro sobe depois.
      await auditar(c, {
        atorTipo: "operador",
        atorId: op.id,
        acao: "envio_bloqueado",
        entidade: "conversa",
        entidadeId: conversa.id,
        detalhes: { codigo: decisao.codigo },
      });
      return { bloqueio: decisao };
    }
    const { mensagemId } = await enfileirarSaida(c, {
      conversaId: conversa.id,
      canal: conversa.canal,
      autor: "operador",
      operadorId: op.id,
      texto,
      opcoes: [],
      modulo: null,
      simulada: deps.simulacao,
      agora,
    });
    await auditar(c, { atorTipo: "operador", atorId: op.id, acao: "resposta_operador", entidade: "mensagem", entidadeId: mensagemId });
    return { mensagemId };
  });

  if ("bloqueio" in r) throw new ErroEnvioBloqueado(r.bloqueio.codigo, r.bloqueio.motivo);
  await despacharPendentes(deps, { conversaId: a.conversaId });
  return r;
}

export async function devolverAoBot(
  deps: Dependencias,
  a: { conversaId: string; operadorId: string; resultado?: string },
): Promise<void> {
  const agora = deps.relogio();
  await emTransacao(deps.pool, async (c) => {
    const op = await operadorAtivo(c, a.operadorId);
    const conversa = await travarConversa(c, a.conversaId);
    const at = await atendimentoAberto(c, conversa.id);
    if (!at) throw new ErroAtendimento("Não há atendimento aberto nesta conversa.");
    if (!podeAgir(op, at)) throw new ErroPermissao("Só a pessoa responsável (ou um admin) pode devolver ao bot.");
    await c.query(
      "update atendimentos set status = 'devolvido', devolvido_em = $2, devolvido_por = $3, resultado = $4 where id = $1",
      [at.id, agora, op.id, a.resultado?.slice(0, 500) ?? null],
    );
    // A sequência de perguntas continua crescendo: ações de menus antigos não casam com perguntas novas.
    const sequencia = lerEstado(conversa.estado).sequencia;
    await c.query("update conversas set controle = 'bot', estado = $2, versao = versao + 1, atualizado_em = $3 where id = $1", [
      conversa.id,
      estadoInicial(sequencia),
      agora,
    ]);
    await auditar(c, {
      atorTipo: "operador",
      atorId: op.id,
      acao: "atendimento_devolvido",
      entidade: "atendimento",
      entidadeId: at.id,
      detalhes: { resultado: a.resultado ?? null },
    });
  });
}
