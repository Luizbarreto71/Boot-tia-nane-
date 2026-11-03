import { textoComOpcoes } from "../canais/tipos.js";
import type { ConfigNegocio } from "../config/negocio.js";
import type { OpcaoResposta } from "../conversa/motor.js";
import type { Cliente } from "../db/pool.js";
import type { CanalId } from "../dominio/elegibilidade.js";
import type { ModuloId, ServicoId } from "../dominio/modulos.js";

/** Operações de banco compartilhadas pelo recebimento e pelo atendimento humano. Todas rodam na transação do chamador. */

export type AtorTipo = "contato" | "bot" | "operador" | "sistema";

export async function auditar(
  c: Cliente,
  a: { atorTipo: AtorTipo; atorId?: string | null; acao: string; entidade?: string; entidadeId?: string; detalhes?: object },
): Promise<void> {
  await c.query(
    "insert into auditoria (ator_tipo, ator_id, acao, entidade, entidade_id, detalhes) values ($1, $2, $3, $4, $5, $6)",
    [a.atorTipo, a.atorId ?? null, a.acao, a.entidade ?? null, a.entidadeId ?? null, a.detalhes ?? {}],
  );
}

export async function notificarEquipe(
  c: Cliente,
  n: { tipo: string; conversaId: string; atendimentoId?: string | null; dados?: object; agora: Date },
): Promise<void> {
  await c.query(
    "insert into notificacoes_equipe (tipo, conversa_id, atendimento_id, dados, criada_em) values ($1, $2, $3, $4, $5)",
    [n.tipo, n.conversaId, n.atendimentoId ?? null, n.dados ?? {}, n.agora],
  );
}

/** Grava a mensagem de saída e o item do outbox na mesma transação. */
export async function enfileirarSaida(
  c: Cliente,
  s: {
    conversaId: string;
    canal: CanalId;
    autor: "bot" | "operador";
    operadorId?: string | null;
    texto: string;
    opcoes: OpcaoResposta[];
    modulo: ModuloId | null;
    simulada: boolean;
    agora: Date;
    /** Quem redigiu a resposta automática: o motor de menus ou a IA. */
    origem?: "motor" | "ia";
  },
): Promise<{ mensagemId: string; envioId: string }> {
  const m = await c.query<{ id: string }>(
    `insert into mensagens (conversa_id, canal, direcao, autor, operador_id, tipo, corpo, dados, modulo, simulada, criada_em)
     values ($1, $2, 'saida', $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
    [
      s.conversaId,
      s.canal,
      s.autor,
      s.operadorId ?? null,
      s.opcoes.length ? "opcoes" : "texto",
      textoComOpcoes(s.texto, s.opcoes),
      { texto: s.texto, opcoes: s.opcoes, ...(s.origem ? { origem: s.origem } : {}) },
      s.modulo,
      s.simulada,
      s.agora,
    ],
  );
  const mensagemId = m.rows[0]!.id;
  const e = await c.query<{ id: string }>(
    `insert into envios (mensagem_id, conversa_id, canal, proxima_tentativa_em, criado_em, atualizado_em)
     values ($1, $2, $3, $4, $4, $4) returning id`,
    [mensagemId, s.conversaId, s.canal, s.agora],
  );
  return { mensagemId, envioId: e.rows[0]!.id };
}

export async function cancelarTarefasPendentes(c: Cliente, contatoId: string, motivo: string, agora: Date): Promise<number> {
  const r = await c.query(
    `update tarefas set status = 'cancelada', motivo_cancelamento = $2, atualizada_em = $3
     where contato_id = $1 and status = 'pendente'`,
    [contatoId, motivo, agora],
  );
  return r.rowCount ?? 0;
}

export type Finalidade = "acompanhamento" | "marketing";

export async function registrarConsentimento(
  c: Cliente,
  r: { contatoId: string; finalidade: Finalidade; status: "concedido" | "revogado"; origem: string; evidencia: string; agora: Date },
): Promise<void> {
  await c.query(
    `insert into consentimentos (contato_id, finalidade, status, origem, evidencia, registrado_em)
     values ($1, $2, $3, $4, $5, $6)`,
    [r.contatoId, r.finalidade, r.status, r.origem, r.evidencia, r.agora],
  );
}

export async function consentimentoVigente(
  c: Cliente,
  contatoId: string,
  finalidade: Finalidade,
): Promise<"concedido" | "revogado" | null> {
  const r = await c.query<{ status: "concedido" | "revogado" }>(
    `select status from consentimentos where contato_id = $1 and finalidade = $2
     order by registrado_em desc, id desc limit 1`,
    [contatoId, finalidade],
  );
  return r.rows[0]?.status ?? null;
}

/** Descadastro: revoga acompanhamento e marketing e cancela tarefas. Não altera controle bot/humano nem etapa comercial. */
export async function aplicarDescadastro(
  c: Cliente,
  d: { contatoId: string; conversaId: string; evidencia: string; agora: Date },
): Promise<void> {
  for (const finalidade of ["acompanhamento", "marketing"] as const) {
    await registrarConsentimento(c, {
      contatoId: d.contatoId,
      finalidade,
      status: "revogado",
      origem: "pedido_do_contato",
      evidencia: d.evidencia,
      agora: d.agora,
    });
  }
  const canceladas = await cancelarTarefasPendentes(c, d.contatoId, "descadastro", d.agora);
  await auditar(c, {
    atorTipo: "contato",
    atorId: d.contatoId,
    acao: "descadastro",
    entidade: "contato",
    entidadeId: d.contatoId,
    detalhes: { tarefasCanceladas: canceladas },
  });
}

const ORDEM_ETAPA_COMERCIAL = ["novo", "interessado", "solicitacao_registrada", "cliente_verificado"];

/** Só avança (nunca regride) e nunca chega a cliente_verificado por aqui: isso exige verificação humana. */
export async function avancarEtapaComercial(c: Cliente, contatoId: string, etapa: "interessado" | "solicitacao_registrada") {
  await c.query(
    `update contatos set etapa_comercial = $2
     where id = $1 and array_position($3::text[], etapa_comercial) < array_position($3::text[], $2)`,
    [contatoId, etapa, ORDEM_ETAPA_COMERCIAL],
  );
}

export interface DadosAgendamento {
  nome: string;
  preferenciaContato: string;
  periodo: string | null;
  horarioTexto: string | null;
}

/**
 * Pedido para a Janiere entrar em contato (não confirma horário). Usado pelo menu e pela IA.
 * Se já houver pedido aberto do mesmo serviço nas últimas 24h, atualiza em vez de duplicar.
 */
export async function registrarSolicitacaoAgendamento(
  c: Cliente,
  s: { contatoId: string; conversaId: string; modulo: ServicoId; dados: DadosAgendamento; agora: Date; ator: "bot" | "agente" },
): Promise<{ id: string; jaExistia: boolean }> {
  await c.query("update contatos set nome = $2, atualizado_em = $3 where id = $1", [s.contatoId, s.dados.nome, s.agora]);
  const existente = await c.query<{ id: string }>(
    `select id from solicitacoes
     where contato_id = $1 and modulo = $2 and tipo = 'agendamento' and status = 'aberta' and criada_em > $3
     order by criada_em desc limit 1`,
    [s.contatoId, s.modulo, new Date(s.agora.getTime() - 24 * 3_600_000)],
  );
  const jaExistia = existente.rows[0]?.id;
  let id: string;
  if (jaExistia) {
    id = jaExistia;
    await c.query("update solicitacoes set dados = $2, atualizada_em = $3 where id = $1", [id, s.dados, s.agora]);
  } else {
    const r = await c.query<{ id: string }>(
      `insert into solicitacoes (contato_id, conversa_id, modulo, tipo, dados, criada_em, atualizada_em)
       values ($1, $2, $3, 'agendamento', $4, $5, $5) returning id`,
      [s.contatoId, s.conversaId, s.modulo, s.dados, s.agora],
    );
    id = r.rows[0]!.id;
  }
  await avancarEtapaComercial(c, s.contatoId, "solicitacao_registrada");
  await notificarEquipe(c, {
    tipo: jaExistia ? "solicitacao_atualizada" : "nova_solicitacao",
    conversaId: s.conversaId,
    dados: { solicitacaoId: id, modulo: s.modulo, ...s.dados },
    agora: s.agora,
  });
  await auditar(c, {
    atorTipo: "bot",
    atorId: s.ator,
    acao: jaExistia ? "solicitacao_atualizada" : "solicitacao_registrada",
    entidade: "solicitacao",
    entidadeId: id,
  });
  return { id, jaExistia: Boolean(jaExistia) };
}

/** Abre (ou reaproveita) o atendimento humano e pausa a automação e as tarefas da conversa. */
export async function abrirAtendimento(
  c: Cliente,
  negocio: ConfigNegocio,
  a: {
    conversaId: string;
    contatoId: string;
    origem: "contato" | "comando" | "fallback" | "operador" | "agente";
    motivo: string;
    resumo: string;
    agora: Date;
    responsavelId?: string;
  },
): Promise<string> {
  let responsavel = a.responsavelId ?? null;
  if (!responsavel && negocio.atendimentoHumano.responsavelPadrao) {
    const r = await c.query<{ id: string }>("select id from operadores where chave = $1 and ativo", [
      negocio.atendimentoHumano.responsavelPadrao,
    ]);
    responsavel = r.rows[0]?.id ?? null;
  }
  const ins = await c.query<{ id: string }>(
    `insert into atendimentos (conversa_id, status, origem, motivo, resumo, responsavel_id, solicitado_em)
     values ($1, 'solicitado', $2, $3, $4, $5, $6)
     on conflict (conversa_id) where status in ('solicitado', 'em_atendimento') do nothing
     returning id`,
    [a.conversaId, a.origem, a.motivo, a.resumo, responsavel, a.agora],
  );
  const id =
    ins.rows[0]?.id ??
    (
      await c.query<{ id: string }>(
        "select id from atendimentos where conversa_id = $1 and status in ('solicitado', 'em_atendimento')",
        [a.conversaId],
      )
    ).rows[0]!.id;
  await c.query("update conversas set controle = 'humano', atualizado_em = $2 where id = $1", [a.conversaId, a.agora]);
  const canceladas = await cancelarTarefasPendentes(c, a.contatoId, "atendimento_humano", a.agora);
  await notificarEquipe(c, {
    tipo: "atendimento_solicitado",
    conversaId: a.conversaId,
    atendimentoId: id,
    dados: { origem: a.origem, motivo: a.motivo, resumo: a.resumo },
    agora: a.agora,
  });
  await auditar(c, {
    atorTipo: a.origem === "operador" ? "operador" : "contato",
    atorId: a.origem === "operador" ? responsavel : a.contatoId,
    acao: "atendimento_solicitado",
    entidade: "atendimento",
    entidadeId: id,
    detalhes: { origem: a.origem, tarefasCanceladas: canceladas },
  });
  return id;
}
