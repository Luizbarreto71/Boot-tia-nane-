import { createHmac, timingSafeEqual } from "node:crypto";
import type { MensagemRecebida } from "../nucleo/recebimento.js";
import { ErroEnvioDefinitivo, ErroEnvioIncerto, textoComOpcoes, type AdaptadorCanal, type EnvioSaida } from "./tipos.js";

/**
 * WhatsApp Cloud API (oficial). Referência conferida em 28/10/2026 (Graph API v26.0):
 * botões de resposta — até 3, título até 20 caracteres, corpo até 1024;
 * lista — até 10 linhas, título da linha até 24, descrição até 72, botão até 20, corpo até 4096.
 */

export interface ConfigWhatsApp {
  tokenAcesso: string;
  idNumero: string;
  versaoGraph: string;
  segredoApp: string;
  tokenVerificacao: string;
}

type Fetch = typeof fetch;
const TEMPO_LIMITE_MS = 15_000;

// ------------------------------------------------------------------ envio

export function corpoDoEnvio(e: Pick<EnvioSaida, "destinatario" | "texto" | "opcoes">): Record<string, unknown> {
  const base = { messaging_product: "whatsapp", recipient_type: "individual", to: e.destinatario };
  const { texto, opcoes } = e;
  if (opcoes.length >= 1 && opcoes.length <= 3 && texto.length <= 1024 && opcoes.every((o) => o.rotulo.length <= 20)) {
    return {
      ...base,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: texto },
        action: { buttons: opcoes.map((o) => ({ type: "reply", reply: { id: o.id, title: o.rotulo } })) },
      },
    };
  }
  if (opcoes.length >= 1 && opcoes.length <= 10 && texto.length <= 4096) {
    return {
      ...base,
      type: "interactive",
      interactive: {
        type: "list",
        body: { text: texto },
        action: {
          button: "Ver opções",
          sections: [
            {
              title: "Opções",
              rows: opcoes.map((o) =>
                o.rotulo.length <= 24
                  ? { id: o.id, title: o.rotulo }
                  : { id: o.id, title: `${o.rotulo.slice(0, 23)}…`, description: o.rotulo.slice(0, 72) },
              ),
            },
          ],
        },
      },
    };
  }
  // Sem opções, ou fora dos limites: texto com as opções numeradas.
  return { ...base, type: "text", text: { body: textoComOpcoes(texto, opcoes).slice(0, 4096), preview_url: false } };
}

export class AdaptadorWhatsApp implements AdaptadorCanal {
  readonly canal = "whatsapp" as const;

  constructor(
    private readonly cfg: Pick<ConfigWhatsApp, "tokenAcesso" | "idNumero" | "versaoGraph">,
    private readonly fetchFn: Fetch = fetch,
  ) {}

  async enviar(envio: EnvioSaida): Promise<{ idProvedor: string }> {
    if (envio.simulada) throw new ErroEnvioDefinitivo("Mensagem simulada não pode sair pelo WhatsApp real.");
    const url = `https://graph.facebook.com/${this.cfg.versaoGraph}/${this.cfg.idNumero}/messages`;
    let resposta: Response;
    try {
      resposta = await this.fetchFn(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.cfg.tokenAcesso}`, "Content-Type": "application/json" },
        body: JSON.stringify(corpoDoEnvio(envio)),
        signal: AbortSignal.timeout(TEMPO_LIMITE_MS),
      });
    } catch (e) {
      const codigo = (e as { cause?: { code?: string } }).cause?.code;
      // Sem conexão estabelecida: a mensagem certamente não saiu, pode repetir.
      if (codigo && ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"].includes(codigo)) throw new Error(`Rede indisponível (${codigo})`);
      // Tempo esgotado ou conexão caída depois de enviar: resultado desconhecido.
      throw new ErroEnvioIncerto(`Sem resposta do WhatsApp (${(e as Error).name}); a mensagem pode ou não ter sido entregue.`);
    }
    const corpo = (await resposta.json().catch(() => null)) as {
      messages?: { id?: string }[];
      error?: { code?: number; message?: string };
    } | null;
    if (resposta.ok && corpo?.messages?.[0]?.id) return { idProvedor: corpo.messages[0].id };

    const detalhe = `HTTP ${resposta.status}${corpo?.error?.code ? ` código ${corpo.error.code}` : ""}: ${corpo?.error?.message ?? "sem detalhe"}`;
    if (resposta.ok) throw new ErroEnvioIncerto(`Resposta sem id de mensagem (${detalhe})`);
    if (resposta.status === 429 || resposta.status >= 500) throw new Error(detalhe);
    throw new ErroEnvioDefinitivo(detalhe);
  }
}

// ------------------------------------------------------------------ webhook

/** X-Hub-Signature-256 = "sha256=" + HMAC-SHA256(segredo do app, corpo bruto), comparado em tempo constante. */
export function assinaturaValida(corpoBruto: Buffer, cabecalho: string | string[] | undefined, segredoApp: string): boolean {
  if (typeof cabecalho !== "string" || !cabecalho.startsWith("sha256=")) return false;
  const recebida = Buffer.from(cabecalho.slice("sha256=".length), "hex");
  const esperada = createHmac("sha256", segredoApp).update(corpoBruto).digest();
  return recebida.length === esperada.length && timingSafeEqual(recebida, esperada);
}

export function tokenVerificacaoConfere(recebido: unknown, esperado: string): boolean {
  if (typeof recebido !== "string") return false;
  const a = Buffer.from(recebido);
  const b = Buffer.from(esperado);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface StatusEntrega {
  idProvedor: string;
  status: string;
  em: Date;
  erro: string | null;
}

export interface EventosExtraidos {
  mensagens: MensagemRecebida[];
  status: StatusEntrega[];
  /** Mudanças descartadas: outro número, outro campo ou formato inesperado. */
  ignorados: { motivo: string; detalhe?: string }[];
}

type Valor = {
  metadata?: { phone_number_id?: string };
  contacts?: { wa_id?: string; profile?: { name?: string } }[];
  messages?: Record<string, any>[];
  statuses?: Record<string, any>[];
};

/** Percorre todas as entradas e mudanças do payload; mensagens e status são tratados separadamente. */
export function extrairEventos(payload: unknown, idNumeroEsperado: string): EventosExtraidos {
  const r: EventosExtraidos = { mensagens: [], status: [], ignorados: [] };
  const p = payload as { object?: string; entry?: { changes?: { field?: string; value?: Valor }[] }[] };
  if (p?.object !== "whatsapp_business_account" || !Array.isArray(p.entry)) {
    r.ignorados.push({ motivo: "objeto_desconhecido" });
    return r;
  }
  for (const entrada of p.entry) {
    for (const mudanca of entrada.changes ?? []) {
      const v = mudanca.value;
      if (mudanca.field !== "messages" || !v) {
        r.ignorados.push({ motivo: "campo_ignorado", detalhe: mudanca.field });
        continue;
      }
      if (v.metadata?.phone_number_id !== idNumeroEsperado) {
        r.ignorados.push({ motivo: "numero_desconhecido", detalhe: v.metadata?.phone_number_id });
        continue;
      }
      for (const s of v.statuses ?? []) {
        if (typeof s.id !== "string" || typeof s.status !== "string") continue;
        const erro = Array.isArray(s.errors) && s.errors[0] ? `${s.errors[0].code ?? ""} ${s.errors[0].title ?? ""}`.trim() : null;
        r.status.push({ idProvedor: s.id, status: s.status, em: dataDe(s.timestamp), erro });
      }
      for (const m of v.messages ?? []) {
        if (typeof m.id !== "string" || typeof m.from !== "string") {
          r.ignorados.push({ motivo: "mensagem_malformada" });
          continue;
        }
        const nomePerfil = v.contacts?.find((c) => c.wa_id === m.from)?.profile?.name ?? null;
        const base = { canal: "whatsapp" as const, contatoExterno: m.from, nomePerfil, idProvedor: m.id, recebidaEm: dataDe(m.timestamp) };
        r.mensagens.push({ ...base, conteudo: conteudoDe(m) });
      }
    }
  }
  return r;
}

function conteudoDe(m: Record<string, any>): MensagemRecebida["conteudo"] {
  if (m.type === "text" && typeof m.text?.body === "string") return { tipo: "texto", texto: m.text.body };
  if (m.type === "interactive") {
    const sel = m.interactive?.list_reply ?? m.interactive?.button_reply;
    if (typeof sel?.id === "string") return { tipo: "acao", id: sel.id, titulo: typeof sel.title === "string" ? sel.title : undefined };
  }
  // Botão de resposta rápida de modelo: o texto do botão vale como mensagem.
  if (m.type === "button" && typeof m.button?.text === "string") return { tipo: "texto", texto: m.button.text };
  return { tipo: "midia", descricao: typeof m.type === "string" ? m.type : "desconhecido" };
}

function dataDe(timestamp: unknown): Date {
  const s = Number(timestamp);
  return Number.isFinite(s) && s > 0 ? new Date(s * 1000) : new Date();
}
