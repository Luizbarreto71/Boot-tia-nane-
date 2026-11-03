import { extrairEventos } from "../canais/whatsapp.js";
import type { Dependencias } from "./dependencias.js";
import { despacharPendentes } from "./envio.js";
import { receberMensagem } from "./recebimento.js";

/**
 * Processa os eventos do webhook gravados em eventos_recebidos. Reprocessar é seguro: as mensagens
 * são deduplicadas pelo id do provedor. Status de entrega só atualiza o envio — nunca aciona o bot.
 */

const MAX_TENTATIVAS = 5;
const PRAZO_PROCESSANDO_MS = 5 * 60_000;

export async function gravarEvento(deps: Dependencias, corpo: unknown): Promise<void> {
  await deps.pool.query(
    `insert into eventos_recebidos (provedor, corpo, recebido_em, proxima_tentativa_em, atualizado_em)
     values ('whatsapp', $1, $2, $2, $2)`,
    [corpo, deps.relogio()],
  );
}

export async function processarEventosPendentes(deps: Dependencias, idNumero: string, limite = 20): Promise<number> {
  const agora = deps.relogio();
  // Processo interrompido no meio: volta para a fila (a deduplicação evita respostas repetidas).
  await deps.pool.query(
    "update eventos_recebidos set status = 'pendente', atualizado_em = $1 where status = 'processando' and atualizado_em < $2",
    [agora, new Date(agora.getTime() - PRAZO_PROCESSANDO_MS)],
  );
  const { rows } = await deps.pool.query<{ id: string; corpo: unknown; tentativas: number; ordem: string }>(
    `update eventos_recebidos e set status = 'processando', tentativas = e.tentativas + 1, atualizado_em = $1
     where e.id in (
       select id from eventos_recebidos where status = 'pendente' and proxima_tentativa_em <= $1
       order by ordem limit $2 for update skip locked)
     returning e.id, e.corpo, e.tentativas, e.ordem`,
    [agora, limite],
  );
  // O UPDATE … RETURNING não garante ordem: processa na ordem de chegada.
  rows.sort((a, b) => Number(a.ordem) - Number(b.ordem));

  for (const evento of rows) {
    try {
      const { mensagens, status, ignorados } = extrairEventos(evento.corpo, idNumero);
      for (const s of status) {
        await deps.pool.query(
          `update envios set status_provedor = $2, status_provedor_em = $3,
                  ultimo_erro = coalesce($4, ultimo_erro), atualizado_em = $5
           where id_provedor = $1`,
          [s.idProvedor, s.status, s.em, s.erro, agora],
        );
      }
      for (const i of ignorados) {
        await deps.pool.query(
          "insert into auditoria (ator_tipo, acao, entidade, entidade_id, detalhes) values ('sistema', 'evento_ignorado', 'evento', $1, $2)",
          [evento.id, i],
        );
      }
      // Em ordem: a mesma pessoa pode mandar várias mensagens num só evento.
      for (const m of mensagens) await receberMensagem(deps, m);
      await deps.pool.query("update eventos_recebidos set status = 'processado', processado_em = $2, atualizado_em = $2 where id = $1", [
        evento.id,
        deps.relogio(),
      ]);
    } catch (e) {
      const esgotou = evento.tentativas >= MAX_TENTATIVAS;
      await deps.pool.query(
        `update eventos_recebidos set status = $2, ultimo_erro = $3, proxima_tentativa_em = $4, atualizado_em = $5 where id = $1`,
        [
          evento.id,
          esgotou ? "erro" : "pendente",
          (e as Error).message?.slice(0, 500) ?? "erro",
          new Date(agora.getTime() + 15_000 * 2 ** (evento.tentativas - 1)),
          agora,
        ],
      );
      deps.log.error("falha ao processar evento do webhook", { eventoId: evento.id, tentativa: evento.tentativas, erro: e });
    }
  }
  return rows.length;
}

/** Laço contínuo: eventos do webhook e novas tentativas do outbox. `acordar()` antecipa a próxima volta. */
export function iniciarTrabalhador(deps: Dependencias, idNumero: string, intervaloMs = 2_000) {
  let parar = false;
  let acordar: (() => void) | null = null;
  const pausa = () =>
    new Promise<void>((resolve) => {
      const t = setTimeout(resolve, intervaloMs);
      acordar = () => {
        clearTimeout(t);
        resolve();
      };
    });
  const laco = (async () => {
    while (!parar) {
      try {
        while ((await processarEventosPendentes(deps, idNumero)) > 0 && !parar);
        await despacharPendentes(deps);
      } catch (e) {
        deps.log.error("falha no laço de processamento", { erro: e });
      }
      if (!parar) await pausa();
    }
  })();
  return {
    acordar: () => acordar?.(),
    async parar() {
      parar = true;
      acordar?.();
      await laco;
    },
  };
}
