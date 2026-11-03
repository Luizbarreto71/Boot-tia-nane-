import { ErroEnvioDefinitivo, ErroEnvioIncerto } from "../canais/tipos.js";
import type { OpcaoResposta } from "../conversa/motor.js";
import { perfilDoCanal, type CanalId } from "../dominio/elegibilidade.js";
import type { ModuloId } from "../dominio/modulos.js";
import type { Dependencias } from "./dependencias.js";
import { avaliarEnvio } from "./politica-envio.js";

/**
 * Despacho do outbox. Cada item é reservado ('enviando'), reavaliado pela política de envio e entregue
 * ao adaptador do canal. Falha comum volta para a fila com recuo exponencial até max_tentativas;
 * resultado incerto (timeout, processo interrompido) vira 'incerto' e não é repetido automaticamente.
 */

const RECUO_BASE_MS = 30_000;
const PRAZO_ENVIANDO_MS = 5 * 60_000;

export interface ResumoDespacho {
  enviados: number;
  bloqueados: number;
  reagendados: number;
  falhas: number;
  incertos: number;
}

interface ItemEnvio {
  id: string;
  conversa_id: string;
  canal: CanalId;
  tentativas: number;
  max_tentativas: number;
  autor: "bot" | "operador";
  modulo: ModuloId | null;
  simulada: boolean;
  dados: { texto?: string; opcoes?: OpcaoResposta[]; origem?: "motor" | "ia" };
  corpo: string;
  ultima_mensagem_contato_em: Date | null;
  id_externo: string;
}

export async function despacharPendentes(
  deps: Dependencias,
  opcoes: { conversaId?: string; limite?: number } = {},
): Promise<ResumoDespacho> {
  const resumo: ResumoDespacho = { enviados: 0, bloqueados: 0, reagendados: 0, falhas: 0, incertos: 0 };
  const agora = deps.relogio();

  await deps.pool.query(
    `update envios set status = 'incerto', atualizado_em = $1,
            ultimo_erro = 'Envio interrompido; resultado desconhecido. Conferir no provedor antes de reenviar.'
     where status = 'enviando' and atualizado_em < $2`,
    [agora, new Date(agora.getTime() - PRAZO_ENVIANDO_MS)],
  );

  const reservados = await deps.pool.query<{ id: string }>(
    `update envios e set status = 'enviando', tentativas = e.tentativas + 1, atualizado_em = $1
     where e.id in (
       select p.id from envios p
       where p.status = 'pendente' and p.proxima_tentativa_em <= $1 and ($2::uuid is null or p.conversa_id = $2::uuid)
         -- nunca ultrapassa uma mensagem mais antiga da mesma conversa que ainda vai sair
         and not exists (
           select 1 from envios a
           where a.conversa_id = p.conversa_id and a.ordem < p.ordem
             and (a.status = 'enviando' or (a.status = 'pendente' and a.proxima_tentativa_em > $1)))
       order by p.ordem
       limit $3
       for update of p skip locked)
     returning e.id`,
    [agora, opcoes.conversaId ?? null, opcoes.limite ?? 50],
  );
  if (!reservados.rowCount) return resumo;

  const { rows: itens } = await deps.pool.query<ItemEnvio>(
    `select e.id, e.conversa_id, e.canal, e.tentativas, e.max_tentativas,
            m.autor, m.modulo, m.simulada, m.dados, m.corpo,
            cv.ultima_mensagem_contato_em, ct.id_externo
     from envios e
     join mensagens m on m.id = e.mensagem_id
     join conversas cv on cv.id = e.conversa_id
     join contatos ct on ct.id = cv.contato_id
     where e.id = any($1::uuid[])
     order by e.ordem`,
    [reservados.rows.map((r) => r.id)],
  );

  const conversasComFalha = new Set<string>();
  for (const item of itens) {
    // Mantém a ordem: depois de uma falha, as mensagens seguintes da conversa esperam a próxima rodada.
    if (conversasComFalha.has(item.conversa_id)) {
      await atualizar(deps, item.id, { status: "pendente", tentativas: item.tentativas - 1, agora });
      continue;
    }
    const texto = item.dados.texto ?? item.corpo;
    const decisao = avaliarEnvio(
      perfilDoCanal(item.canal),
      deps.negocio,
      { ultimaMensagemContatoEm: item.ultima_mensagem_contato_em, consentimentoAcompanhamento: false },
      { origem: item.autor, modulo: item.modulo, texto },
      agora,
    );
    if (!decisao.permitido) {
      await atualizar(deps, item.id, { status: "bloqueado", erro: `${decisao.codigo}: ${decisao.motivo}`, agora });
      await deps.pool.query(
        "insert into auditoria (ator_tipo, acao, entidade, entidade_id, detalhes) values ('sistema', 'envio_bloqueado', 'envio', $1, $2)",
        [item.id, { codigo: decisao.codigo, origem: item.autor }],
      );
      resumo.bloqueados += 1;
      continue;
    }
    const adaptador = deps.adaptadores[item.canal];
    if (!adaptador) {
      await atualizar(deps, item.id, { status: "falhou", erro: `Sem adaptador configurado para ${item.canal}`, agora });
      resumo.falhas += 1;
      continue;
    }
    try {
      const { idProvedor } = await adaptador.enviar({
        envioId: item.id,
        canal: item.canal,
        destinatario: item.id_externo,
        texto,
        opcoes: item.dados.opcoes ?? [],
        simulada: item.simulada,
        origem: item.autor === "operador" ? "operador" : (item.dados.origem ?? "motor"),
      });
      await deps.pool.query(
        `update envios set status = 'enviado', id_provedor = $2, enviado_em = $3, atualizado_em = $3, ultimo_erro = null
         where id = $1`,
        [item.id, idProvedor, agora],
      );
      resumo.enviados += 1;
    } catch (e) {
      conversasComFalha.add(item.conversa_id);
      const erro = (e instanceof Error ? e.message : String(e)).slice(0, 500);
      if (e instanceof ErroEnvioIncerto) {
        await atualizar(deps, item.id, { status: "incerto", erro, agora });
        resumo.incertos += 1;
      } else if (e instanceof ErroEnvioDefinitivo || item.tentativas >= item.max_tentativas) {
        await atualizar(deps, item.id, { status: "falhou", erro, agora });
        resumo.falhas += 1;
      } else {
        const proxima = new Date(agora.getTime() + RECUO_BASE_MS * 2 ** (item.tentativas - 1));
        await atualizar(deps, item.id, { status: "pendente", erro, agora, proxima });
        resumo.reagendados += 1;
      }
      deps.log.warn("falha no envio", { envioId: item.id, canal: item.canal, tentativa: item.tentativas, erro });
    }
  }
  return resumo;
}

async function atualizar(
  deps: Dependencias,
  id: string,
  a: { status: string; agora: Date; erro?: string; tentativas?: number; proxima?: Date },
): Promise<void> {
  await deps.pool.query(
    `update envios set status = $2, atualizado_em = $3,
            ultimo_erro = coalesce($4, ultimo_erro),
            tentativas = coalesce($5, tentativas),
            proxima_tentativa_em = coalesce($6, proxima_tentativa_em)
     where id = $1`,
    [id, a.status, a.agora, a.erro ?? null, a.tentativas ?? null, a.proxima ?? null],
  );
}
