import { carregarHistorico, ErroAgente, executarTurnoAgente, type ResultadoAgente } from "../agente/agente.js";
import type { AlvoFerramenta } from "../agente/ferramentas.js";
import { detectarComando } from "../conversa/comandos.js";
import { estadoInicial, lerEstado, type EstadoConversa } from "../conversa/estado.js";
import { destinoDaEntrada, processar, type ContextoMotor, type Efeito, type Entrada, type Resultado } from "../conversa/motor.js";
import { emTransacao, type Cliente } from "../db/pool.js";
import { perfilDoCanal, type CanalId, type PerfilCanal } from "../dominio/elegibilidade.js";
import { DEFINICOES, type ModuloId } from "../dominio/modulos.js";
import { normalizar } from "../lib/texto.js";
import type { Dependencias } from "./dependencias.js";
import { despacharPendentes } from "./envio.js";
import {
  abrirAtendimento,
  aplicarDescadastro,
  auditar,
  avancarEtapaComercial,
  enfileirarSaida,
  notificarEquipe,
  registrarSolicitacaoAgendamento,
} from "./persistencia.js";
import { avaliarEnvio } from "./politica-envio.js";

/**
 * Entrada única do núcleo para mensagens de contatos (simulador e webhook do WhatsApp).
 * Numa só transação: identifica o contato pelo canal (nunca por dado do texto), trava a conversa,
 * deduplica pelo id do provedor, decide quem responde (motor de menus ou IA), aplica os efeitos,
 * grava o estado e o outbox. O despacho acontece depois do commit. Se a transação falhar, a
 * exceção sobe — nada é confirmado como recebido.
 */

export interface MensagemRecebida {
  canal: CanalId;
  contatoExterno: string;
  nomePerfil?: string | null;
  idProvedor: string;
  recebidaEm: Date;
  conteudo:
    | { tipo: "texto"; texto: string }
    | { tipo: "acao"; id: string; titulo?: string }
    | { tipo: "midia"; descricao: string };
}

export type ResultadoRecebimento =
  | { status: "processada"; conversaId: string; respostas: number; respondidaPor: "motor" | "ia" }
  | { status: "duplicada"; conversaId: string }
  | { status: "pausada"; conversaId: string };

interface LinhaConversa {
  id: string;
  estado: unknown;
  controle: "bot" | "humano";
  boas_vindas_em: Date | null;
}

const PERSONA_INDEVIDA = /\b(sou a janiere|aqui (é|e) a janiere|eu sou a nutricionista|eu sou a personal)\b/i;
const LIMITE_RESPOSTA_IA = 4096;

export async function receberMensagem(deps: Dependencias, msg: MensagemRecebida): Promise<ResultadoRecebimento> {
  const perfil = perfilDoCanal(msg.canal);
  if (perfil.apenasSimulacao && !deps.simulacao) throw new Error(`O perfil ${perfil.id} só existe em simulação.`);
  if (!msg.idProvedor || !msg.contatoExterno) throw new Error("idProvedor e contatoExterno são obrigatórios.");
  const agora = deps.relogio();

  const resultado = await emTransacao(deps.pool, async (c): Promise<ResultadoRecebimento> => {
    const contato = (
      await c.query<{ id: string; nome: string | null }>(
        `insert into contatos (canal, id_externo, nome_perfil, simulado, criado_em, atualizado_em)
         values ($1, $2, $3, $4, $5, $5)
         on conflict (canal, id_externo) do update
           set nome_perfil = coalesce(excluded.nome_perfil, contatos.nome_perfil), atualizado_em = excluded.atualizado_em
         returning id, nome`,
        [msg.canal, msg.contatoExterno, msg.nomePerfil?.slice(0, 120) ?? null, deps.simulacao, agora],
      )
    ).rows[0]!;

    await c.query(
      `insert into conversas (contato_id, canal, estado, criado_em, atualizado_em) values ($1, $2, $3, $4, $4)
       on conflict (contato_id) do nothing`,
      [contato.id, msg.canal, estadoInicial(), agora],
    );
    const conversa = (
      await c.query<LinhaConversa>(
        "select id, estado, controle, boas_vindas_em from conversas where contato_id = $1 for update",
        [contato.id],
      )
    ).rows[0]!;

    const ins = await c.query(
      `insert into mensagens (conversa_id, canal, direcao, autor, id_provedor, tipo, corpo, dados, simulada, criada_em)
       values ($1, $2, 'entrada', 'contato', $3, $4, $5, $6, $7, $8)
       on conflict (canal, id_provedor) where direcao = 'entrada' do nothing
       returning id`,
      [
        conversa.id,
        msg.canal,
        msg.idProvedor,
        msg.conteudo.tipo,
        corpoDaEntrada(msg),
        msg.conteudo.tipo === "acao" ? { acaoId: msg.conteudo.id } : {},
        deps.simulacao,
        msg.recebidaEm,
      ],
    );
    if (!ins.rowCount) return { status: "duplicada", conversaId: conversa.id };

    await c.query(
      `update conversas
       set ultima_mensagem_contato_em = greatest(coalesce(ultima_mensagem_contato_em, $2), $2), atualizado_em = $3
       where id = $1`,
      [conversa.id, msg.recebidaEm, agora],
    );

    if (conversa.controle === "humano") {
      await registrarDuranteAtendimento(c, { msg, contatoId: contato.id, conversaId: conversa.id, agora });
      return { status: "pausada", conversaId: conversa.id };
    }

    const entrada: Entrada =
      msg.conteudo.tipo === "texto"
        ? { tipo: "texto", texto: msg.conteudo.texto }
        : msg.conteudo.tipo === "acao"
          ? { tipo: "acao", id: msg.conteudo.id }
          : { tipo: "midia", descricao: msg.conteudo.descricao };
    const estado = lerEstado(conversa.estado);
    const ctxMotor: ContextoMotor = {
      perfil,
      negocio: deps.negocio,
      contato: { nome: contato.nome, jaRecebeuBoasVindas: conversa.boas_vindas_em !== null },
      agora,
    };

    let r: Resultado | null = null;
    let respondidaPor: "motor" | "ia" = "motor";
    if (deps.agente && destinoDaEntrada(estado, entrada, ctxMotor) === "agente") {
      r = await turnoDaIA(c, deps, { msg, contatoId: contato.id, conversaId: conversa.id, perfil, agora, estado, ctxMotor });
      if (r) respondidaPor = "ia";
    }
    r ??= processar(estado, entrada, ctxMotor);

    await aplicarEfeitos(c, deps, { contatoId: contato.id, conversaId: conversa.id, perfil, agora }, r.efeitos);
    for (const [i, resposta] of r.respostas.entries()) {
      await enfileirarSaida(c, {
        conversaId: conversa.id,
        canal: msg.canal,
        autor: "bot",
        texto: resposta.texto,
        opcoes: resposta.opcoes,
        modulo: resposta.modulo,
        simulada: deps.simulacao,
        agora,
        // Na resposta da IA, só a primeira mensagem é redigida pelo modelo; um menu que venha depois é do motor.
        origem: respondidaPor === "ia" && i === 0 ? "ia" : "motor",
      });
    }
    await c.query("update conversas set estado = $2, versao = versao + 1, atualizado_em = $3 where id = $1", [
      conversa.id,
      r.estado,
      agora,
    ]);
    return { status: "processada", conversaId: conversa.id, respostas: r.respostas.length, respondidaPor };
  });

  if (resultado.status === "processada") {
    try {
      await despacharPendentes(deps, { conversaId: resultado.conversaId });
    } catch (e) {
      // A mensagem e as respostas já estão gravadas no outbox; o despacho pode ser refeito.
      deps.log.error("falha ao despachar respostas", { conversaId: resultado.conversaId, erro: e });
    }
  }
  return resultado;
}

function corpoDaEntrada(msg: MensagemRecebida): string {
  switch (msg.conteudo.tipo) {
    case "texto":
      return msg.conteudo.texto.slice(0, 4096);
    case "acao":
      return `[ação] ${(msg.conteudo.titulo ?? msg.conteudo.id).slice(0, 200)}`;
    case "midia":
      return `[${msg.conteudo.descricao.slice(0, 40)}]`;
  }
}

/**
 * Turno da IA dentro de um savepoint. Se a IA falhar, for recusada, estourar limites ou redigir algo
 * que a política barraria, tudo o que as ferramentas fizeram é desfeito e o motor responde.
 */
async function turnoDaIA(
  c: Cliente,
  deps: Dependencias,
  a: {
    msg: MensagemRecebida;
    contatoId: string;
    conversaId: string;
    perfil: PerfilCanal;
    agora: Date;
    estado: EstadoConversa;
    ctxMotor: ContextoMotor;
  },
): Promise<Resultado | null> {
  const alvo: AlvoFerramenta = {
    c,
    negocio: deps.negocio,
    perfil: a.perfil,
    contatoId: a.contatoId,
    conversaId: a.conversaId,
    agora: a.agora,
    turno: { mostrarMenu: false, atendimentoAberto: false, solicitacoes: 0 },
  };
  await c.query("savepoint turno_ia");
  let ra: ResultadoAgente;
  try {
    const abertas = await c.query<{ modulo: ModuloId }>(
      "select modulo from solicitacoes where contato_id = $1 and tipo = 'agendamento' and status = 'aberta'",
      [a.contatoId],
    );
    ra = await executarTurnoAgente(deps.agente!, alvo, {
      historico: await carregarHistorico(c, a.conversaId),
      turno: {
        agora: a.agora,
        primeiroContato: !a.ctxMotor.contato.jaRecebeuBoasVindas,
        nomeInformado: a.ctxMotor.contato.nome,
        solicitacoesAbertas: abertas.rows.map((s) => DEFINICOES[s.modulo]?.titulo ?? s.modulo),
      },
    });
    if (ra.texto.length > LIMITE_RESPOSTA_IA) throw new ErroAgente("resposta_longa");
    if (PERSONA_INDEVIDA.test(ra.texto)) throw new ErroAgente("persona_indevida");
    const decisao = avaliarEnvio(
      a.perfil,
      deps.negocio,
      { ultimaMensagemContatoEm: a.msg.recebidaEm, consentimentoAcompanhamento: false },
      { origem: "bot", modulo: null, texto: ra.texto },
      a.agora,
    );
    if (!decisao.permitido) throw new ErroAgente(`saida_${decisao.codigo}`);
    await c.query("release savepoint turno_ia");
  } catch (e) {
    await c.query("rollback to savepoint turno_ia");
    const motivo = e instanceof ErroAgente ? e.motivo : "erro_interno";
    deps.log.warn("IA não respondeu; usando o motor de menus", { conversaId: a.conversaId, motivo, erro: e });
    await auditar(c, { atorTipo: "sistema", acao: "ia_falhou", entidade: "conversa", entidadeId: a.conversaId, detalhes: { motivo } });
    return null;
  }

  await auditar(c, {
    atorTipo: "bot",
    atorId: "agente",
    acao: "ia_turno",
    entidade: "conversa",
    entidadeId: a.conversaId,
    detalhes: {
      modelo: deps.agente!.modelo,
      prompt: ra.versaoPrompt,
      chamadas: ra.chamadas,
      ferramentas: ra.ferramentas,
      tokensEntrada: ra.uso.entrada,
      tokensSaida: ra.uso.saida,
      tokensCache: ra.uso.cacheLido,
      latenciaMs: ra.latenciaMs,
    },
  });

  // A conversa livre da IA substitui qualquer pergunta pendente do menu. A sequência continua crescendo.
  let estado: EstadoConversa = estadoInicial(a.estado.sequencia);
  const resultado: Resultado = {
    estado,
    respostas: [{ texto: ra.texto, opcoes: [], modulo: null }],
    efeitos: a.ctxMotor.contato.jaRecebeuBoasVindas ? [] : [{ tipo: "boas_vindas" }],
  };
  if (alvo.turno.mostrarMenu && !alvo.turno.atendimentoAberto) {
    const menu = processar(estado, { tipo: "texto", texto: "MENU" }, {
      ...a.ctxMotor,
      contato: { ...a.ctxMotor.contato, jaRecebeuBoasVindas: true },
    });
    resultado.respostas.push(...menu.respostas);
    estado = menu.estado;
    resultado.estado = estado;
  }
  return resultado;
}

/** Bot pausado: só registra. Descadastro continua valendo; a equipe é avisada. */
async function registrarDuranteAtendimento(
  c: Cliente,
  a: { msg: MensagemRecebida; contatoId: string; conversaId: string; agora: Date },
): Promise<void> {
  const texto = a.msg.conteudo.tipo === "texto" ? a.msg.conteudo.texto : "";
  if (detectarComando(normalizar(texto))?.tipo === "descadastro") {
    await aplicarDescadastro(c, { contatoId: a.contatoId, conversaId: a.conversaId, evidencia: texto.slice(0, 200), agora: a.agora });
    await notificarEquipe(c, { tipo: "descadastro_em_atendimento", conversaId: a.conversaId, agora: a.agora });
    return;
  }
  await notificarEquipe(c, { tipo: "mensagem_em_atendimento", conversaId: a.conversaId, agora: a.agora });
}

async function aplicarEfeitos(
  c: Cliente,
  deps: Dependencias,
  alvo: { contatoId: string; conversaId: string; perfil: PerfilCanal; agora: Date },
  efeitos: Efeito[],
): Promise<void> {
  const { contatoId, conversaId, agora } = alvo;
  for (const e of efeitos) {
    switch (e.tipo) {
      case "boas_vindas":
        await c.query("update conversas set boas_vindas_em = coalesce(boas_vindas_em, $2) where id = $1", [conversaId, agora]);
        break;
      case "registrar_nome":
        await c.query("update contatos set nome = $2, atualizado_em = $3 where id = $1", [contatoId, e.nome, agora]);
        break;
      case "interesse":
        await c.query(
          `insert into solicitacoes (contato_id, conversa_id, modulo, tipo, criada_em, atualizada_em)
           values ($1, $2, $3, 'interesse', $4, $4)
           on conflict (contato_id, modulo) where tipo = 'interesse' do nothing`,
          [contatoId, conversaId, e.modulo, agora],
        );
        await avancarEtapaComercial(c, contatoId, "interessado");
        break;
      case "registrar_solicitacao":
        await registrarSolicitacaoAgendamento(c, { contatoId, conversaId, modulo: e.modulo, dados: e.dados, agora, ator: "bot" });
        break;
      case "solicitar_humano":
        await abrirAtendimento(c, deps.negocio, {
          conversaId,
          contatoId,
          origem: e.origem,
          motivo: e.motivo,
          resumo: e.resumo,
          agora,
        });
        break;
      case "descadastrar":
        await aplicarDescadastro(c, { contatoId, conversaId, evidencia: e.evidencia, agora });
        break;
      case "pedido_cancelamento": {
        const ultima = await c.query<{ modulo: string }>(
          "select modulo from solicitacoes where contato_id = $1 and tipo = 'agendamento' order by criada_em desc limit 1",
          [contatoId],
        );
        const s = await c.query<{ id: string }>(
          `insert into solicitacoes (contato_id, conversa_id, modulo, tipo, dados, criada_em, atualizada_em)
           values ($1, $2, $3, 'cancelamento', $4, $5, $5) returning id`,
          [contatoId, conversaId, ultima.rows[0]?.modulo ?? "falar_janiere", { evidencia: e.evidencia }, agora],
        );
        await notificarEquipe(c, { tipo: "pedido_cancelamento", conversaId, dados: { solicitacaoId: s.rows[0]!.id }, agora });
        await auditar(c, { atorTipo: "contato", atorId: contatoId, acao: "pedido_cancelamento", entidade: "solicitacao", entidadeId: s.rows[0]!.id });
        break;
      }
      case "modulo_bloqueado":
        await auditar(c, {
          atorTipo: "bot",
          acao: "modulo_bloqueado",
          entidade: "conversa",
          entidadeId: conversaId,
          detalhes: { canal: alvo.perfil.id, modulos: e.modulos },
        });
        break;
    }
  }
}
