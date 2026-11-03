import { randomUUID } from "node:crypto";
import type { ConfigAgente } from "../../src/agente/agente.js";
import { AdaptadorSimulacao } from "../../src/canais/simulacao.js";
import type { ConfigNegocio } from "../../src/config/negocio.js";
import { criarPool, type Pool } from "../../src/db/pool.js";
import type { CanalId } from "../../src/dominio/elegibilidade.js";
import { criarLogger } from "../../src/lib/log.js";
import type { Dependencias } from "../../src/nucleo/dependencias.js";
import { garantirOperador } from "../../src/nucleo/operadores.js";
import { receberMensagem } from "../../src/nucleo/recebimento.js";
import { QUARTA_MEIO_DIA } from "./conversa.js";
import { negocioDemo } from "./negocio.js";

export const URL_TESTE = process.env.TEST_DATABASE_URL ?? "postgres://postgres@localhost:54400/tia_nane_test";

export const TABELAS =
  "eventos_recebidos, auditoria, notificacoes_equipe, tarefas, consentimentos, atendimentos, solicitacoes, envios, mensagens, conversas, contatos, operadores";

export async function limparBanco(pool: Pool) {
  await pool.query(`truncate ${TABELAS} restart identity cascade`);
}

/** Núcleo completo sobre o banco de teste, com relógio controlado e adaptador de simulação. */
export function montarTeste(opcoes: { negocio?: ConfigNegocio; pool?: Pool; canal?: CanalId; agente?: ConfigAgente } = {}) {
  const pool = opcoes.pool ?? criarPool(URL_TESTE, 5);
  let agora = QUARTA_MEIO_DIA;
  const adaptador = new AdaptadorSimulacao("whatsapp");
  const logs: string[] = [];
  const deps: Dependencias = {
    pool,
    negocio: opcoes.negocio ?? negocioDemo(),
    adaptadores: { whatsapp: adaptador, canal_proprio: new AdaptadorSimulacao("canal_proprio") },
    relogio: () => agora,
    simulacao: true,
    log: criarLogger({ nivel: "debug", escrever: (l) => logs.push(l) }),
    agente: opcoes.agente ?? null,
  };

  const enviar = (contato: string, texto: string, idProvedor = `wamid.teste-${randomUUID()}`) =>
    receberMensagem(deps, {
      canal: opcoes.canal ?? "whatsapp",
      contatoExterno: contato,
      idProvedor,
      recebidaEm: agora,
      conteudo: { tipo: "texto", texto },
    });

  const acao = (contato: string, id: string) =>
    receberMensagem(deps, {
      canal: opcoes.canal ?? "whatsapp",
      contatoExterno: contato,
      idProvedor: `wamid.teste-${randomUUID()}`,
      recebidaEm: agora,
      conteudo: { tipo: "acao", id },
    });

  /** Textos que o adaptador entregou para um contato, em ordem. */
  const recebidas = (contato: string) => adaptador.enviados.filter((e) => e.destinatario === contato).map((e) => e.texto);

  return {
    deps,
    pool,
    adaptador,
    logs,
    enviar,
    acao,
    recebidas,
    avancar: (ms: number) => {
      agora = new Date(agora.getTime() + ms);
    },
    agora: () => agora,
    encerrar: () => pool.end(),
  };
}

export async function criarOperadores(pool: Pool) {
  const janiere = await garantirOperador(pool, { chave: "janiere", nome: "Janiere", papel: "admin" });
  const ana = await garantirOperador(pool, { chave: "ana", nome: "Ana", papel: "atendente" });
  const bia = await garantirOperador(pool, { chave: "bia", nome: "Bia", papel: "atendente" });
  const inativo = await garantirOperador(pool, { chave: "ex", nome: "Ex-atendente", papel: "atendente" });
  await pool.query("update operadores set ativo = false where id = $1", [inativo]);
  return { janiere, ana, bia, inativo };
}

export async function conversaDe(pool: Pool, contato: string) {
  const r = await pool.query(
    `select cv.*, ct.nome, ct.nome_perfil, ct.etapa_comercial, ct.id as contato_id
     from conversas cv join contatos ct on ct.id = cv.contato_id where ct.id_externo = $1`,
    [contato],
  );
  return r.rows[0];
}

export async function criarTarefaPendente(pool: Pool, contato: string, agora: Date) {
  const cv = await conversaDe(pool, contato);
  await pool.query(
    `insert into tarefas (contato_id, conversa_id, tipo, finalidade, executar_em) values ($1, $2, 'acompanhamento_d1', 'acompanhamento', $3)`,
    [cv.contato_id, cv.id, new Date(agora.getTime() + 86_400_000)],
  );
}
