import type { ConfigNegocio } from "../config/negocio.js";
import { avaliarModulo, modulosVisiveis, type PerfilCanal } from "../dominio/elegibilidade.js";
import { DEFINICOES, ehServico, type ModuloId, type ServicoId } from "../dominio/modulos.js";
import { capitalizarNome, normalizar } from "../lib/texto.js";
import { detectarComando, type Comando } from "./comandos.js";
import { idAcao, lerIdAcao, type Etapa, type EstadoConversa } from "./estado.js";
import { detectarModulos, ehAgradecimento, ehSaudacao, temasNaoPermitidos } from "./intencoes.js";
import { T, foraDoExpediente } from "./textos.js";

/**
 * Motor da conversa: função pura (estado, entrada, contexto) → (novo estado, respostas, efeitos).
 * Não acessa banco nem rede. Menus, mudança de estado e restrições de canal são decididos aqui,
 * por código; os efeitos são aplicados pelo núcleo dentro da mesma transação que grava o estado.
 */

export interface ContextoMotor {
  perfil: PerfilCanal;
  negocio: ConfigNegocio;
  contato: { nome: string | null; jaRecebeuBoasVindas: boolean };
  agora: Date;
}

export type Entrada =
  | { tipo: "texto"; texto: string }
  | { tipo: "acao"; id: string }
  /** Áudio, imagem, figurinha etc.: registrados, ainda não interpretados. */
  | { tipo: "midia"; descricao: string };

export interface OpcaoResposta {
  id: string;
  numero: number;
  rotulo: string;
}

export interface Resposta {
  texto: string;
  opcoes: OpcaoResposta[];
  /** Módulo a que a mensagem pertence; o despacho confere a elegibilidade de novo. */
  modulo: ModuloId | null;
}

export interface DadosSolicitacao {
  nome: string;
  preferenciaContato: string;
  periodo: string | null;
  horarioTexto: string | null;
}

export type Efeito =
  | { tipo: "boas_vindas" }
  | { tipo: "registrar_nome"; nome: string }
  | { tipo: "interesse"; modulo: ServicoId }
  | { tipo: "registrar_solicitacao"; modulo: ServicoId; dados: DadosSolicitacao }
  | { tipo: "solicitar_humano"; origem: "contato" | "comando" | "fallback"; motivo: string; resumo: string }
  | { tipo: "descadastrar"; evidencia: string }
  | { tipo: "pedido_cancelamento"; evidencia: string }
  | { tipo: "modulo_bloqueado"; modulos: ModuloId[] };

export interface Resultado {
  estado: EstadoConversa;
  respostas: Resposta[];
  efeitos: Efeito[];
}

export function processar(estado: EstadoConversa, entrada: Entrada, ctx: ContextoMotor): Resultado {
  const motor = new Motor(estado, ctx);
  motor.executar(entrada);
  return motor.resultado();
}

/**
 * Quem responde esta entrada quando a IA está ligada. O código fica com tudo o que ele resolve
 * com segurança — comandos, ações e números da pergunta pendente, assuntos bloqueados no canal,
 * saudações — e a IA fica com o texto livre.
 */
export function destinoDaEntrada(estado: EstadoConversa, entrada: Entrada, ctx: ContextoMotor): "motor" | "agente" {
  return new Motor(estado, ctx).destino(entrada);
}

const LIMITE_TEXTO = 1000;
const LIMITE_HISTORICO = 12;
const ETAPAS_DE_FLUXO: readonly Etapa[] = [
  "esclarecimento",
  "servico",
  "coleta_nome",
  "coleta_contato",
  "coleta_periodo",
  "confirmacao",
  "assunto_humano",
  "oferta_humano",
  "confirmar_cancelamento",
];

const ALIASES: Partial<Record<Etapa, Record<string, string[]>>> = {
  servico: {
    solicitar: ["sim", "s", "quero", "quero sim", "pode", "pode ser", "ok", "claro", "bora", "vamos", "solicitar", "agendar", "marcar"],
    menu: ["nao", "n", "agora nao", "nao obrigado", "nao obrigada", "depois"],
  },
  confirmacao: {
    confirmar: ["sim", "s", "confirmo", "confirmar", "isso", "certo", "correto", "ok", "pode", "esta certo", "ta certo", "tudo certo"],
    corrigir: ["nao", "n", "corrigir", "errado", "esta errado", "alterar", "mudar", "trocar"],
  },
  oferta_humano: {
    humano: ["sim", "s", "quero", "pode", "ok"],
    menu: ["nao", "n", "ver menu", "opcoes"],
  },
  confirmar_cancelamento: {
    sim: ["sim", "s", "quero", "isso"],
    nao: ["nao", "n"],
  },
};

const NAO_E_NOME =
  /\b(quero|queria|gostaria|preco|valor|quanto|como|qual|quando|onde|nao|sim|obrigad\w*|consulta|agendar|horario|duvida|pode|voce|vc|ajuda|informac\w*)\b/;
const PARECE_HORARIO =
  /(\b\d{1,2}\s*(h|hs|hrs|horas?)\b|\b\d{1,2}:\d{2}\b|\b(segunda|terca|quarta|quinta|sexta|sabado|domingo|fim de semana|final de semana|depois d|antes d|a partir d|apos|manha|tarde|noite|almoco|cedo)\b)/;

type Casamento = { tipo: "ok"; valor: string } | { tipo: "numero_invalido" } | { tipo: "nenhum" };

class Motor {
  private readonly s: EstadoConversa;
  private readonly respostas: Resposta[] = [];
  private readonly efeitos: Efeito[] = [];
  private buffer: string[] = [];

  constructor(
    estado: EstadoConversa,
    private readonly ctx: ContextoMotor,
  ) {
    this.s = structuredClone(estado);
  }

  resultado(): Resultado {
    this.descarregar();
    return { estado: this.s, respostas: this.respostas, efeitos: this.efeitos };
  }

  destino(entrada: Entrada): "motor" | "agente" {
    if (entrada.tipo !== "texto") return "motor";
    const texto = entrada.texto.trim().slice(0, LIMITE_TEXTO);
    const n = normalizar(texto);
    if (!n || detectarComando(n)) return "motor";
    if (temasNaoPermitidos(n, this.ctx.perfil, this.ctx.negocio).length) return "motor";
    if (ehSaudacao(n) || ehAgradecimento(n)) return "motor";
    if (!this.ctx.contato.jaRecebeuBoasVindas) return "agente";
    switch (this.s.etapa) {
      case "assunto_humano":
        return "motor";
      case "coleta_nome":
        return !detectarModulos(n).length && !NAO_E_NOME.test(n) && extrairNome(texto) ? "motor" : "agente";
      case "coleta_periodo":
        if (PARECE_HORARIO.test(n)) return "motor";
        break;
    }
    return this.casarOpcao(n).tipo === "nenhum" ? "agente" : "motor";
  }

  executar(entrada: Entrada): void {
    if (entrada.tipo === "acao") return this.acao(entrada.id);
    if (entrada.tipo === "midia") {
      if (!this.ctx.contato.jaRecebeuBoasVindas) {
        this.dizer(T.boasVindas(this.ctx.negocio));
        this.efeitos.push({ tipo: "boas_vindas" });
      }
      this.dizer(T.midia);
      return this.s.pergunta ? this.renderizar(true) : this.descarregar();
    }

    const texto = entrada.texto.trim().slice(0, LIMITE_TEXTO);
    const n = normalizar(texto);
    const cmd = detectarComando(n);

    if (!this.ctx.contato.jaRecebeuBoasVindas && cmd?.tipo !== "descadastro" && cmd?.tipo !== "humano") {
      this.dizer(T.boasVindas(this.ctx.negocio));
      this.efeitos.push({ tipo: "boas_vindas" });
      if (!cmd) {
        const modulos = detectarModulos(n);
        return modulos.length ? this.rotearModulos(modulos) : this.irMenu();
      }
    }
    if (cmd) return this.comando(cmd, texto);
    if (!n) return this.falhar();
    return this.porEtapa(texto, n);
  }

  // ---------------------------------------------------------------- entradas

  private acao(id: string): void {
    const sel = lerIdAcao(id);
    const p = this.s.pergunta;
    const opcao =
      sel && p && p.tipo === "opcoes" && sel.perguntaId === p.id ? p.opcoes.find((o) => o.numero === sel.numero) : undefined;
    if (!opcao) {
      this.dizer(T.opcaoAntiga);
      return this.s.etapa === "livre" ? this.irMenu() : this.renderizar(true);
    }
    this.entendeu();
    return this.selecionar(opcao.valor);
  }

  private comando(cmd: Comando, texto: string): void {
    this.entendeu();
    switch (cmd.tipo) {
      case "descadastro":
        this.efeitos.push({ tipo: "descadastrar", evidencia: texto.slice(0, 200) });
        this.dizer(T.descadastrado);
        return this.irLivre();
      case "humano":
        return this.solicitarHumano("comando", "Pediu atendimento humano");
      case "menu":
        return this.irMenu();
      case "voltar":
        return this.voltar();
      case "cancelar_solicitacao":
        return this.registrarCancelamento(texto);
      case "cancelar_fluxo":
        if (ETAPAS_DE_FLUXO.includes(this.s.etapa)) {
          this.dizer(T.fluxoCancelado);
          return this.irMenu();
        }
        return this.avancar("confirmar_cancelamento");
    }
  }

  private porEtapa(texto: string, n: string): void {
    if (this.s.etapa === "coleta_nome") return this.receberNome(texto, n);
    if (this.s.etapa === "assunto_humano") return this.receberAssunto(texto, n);

    const c = this.casarOpcao(n);
    if (c.tipo === "ok") {
      this.entendeu();
      return this.selecionar(c.valor);
    }
    if (c.tipo === "numero_invalido") return this.falhar();

    if (this.s.etapa === "livre" || this.s.etapa === "menu" || this.s.etapa === "esclarecimento" || this.s.etapa === "servico") {
      const modulos = detectarModulos(n);
      if (modulos.length) {
        this.entendeu();
        return this.rotearModulos(modulos);
      }
    }
    if (this.s.etapa === "coleta_periodo" && PARECE_HORARIO.test(n)) {
      if (temasNaoPermitidos(n, this.ctx.perfil, this.ctx.negocio).length) return this.falhar();
      this.entendeu();
      this.s.dados.periodo = undefined;
      this.s.dados.horarioTexto = texto.slice(0, 80);
      return this.avancar("confirmacao");
    }
    if (ehSaudacao(n)) {
      if (this.s.etapa === "livre") return this.irMenu();
      this.dizer(T.continuar);
      return this.renderizar(true);
    }
    if (ehAgradecimento(n)) {
      this.dizer(T.deNada);
      return this.descarregar();
    }
    return this.falhar();
  }

  private receberNome(texto: string, n: string): void {
    if (ehSaudacao(n)) {
      this.dizer(T.continuar);
      return this.renderizar(true);
    }
    const nome = detectarModulos(n).length || NAO_E_NOME.test(n) ? null : extrairNome(texto);
    if (!nome) return this.falhar(T.nomeInvalido);
    this.entendeu();
    this.s.dados.nome = nome;
    this.efeitos.push({ tipo: "registrar_nome", nome });
    this.dizer(`Prazer, ${nome}!`);
    return this.avancar("coleta_contato");
  }

  private receberAssunto(texto: string, n: string): void {
    if (ehSaudacao(n)) {
      this.dizer(T.continuar);
      return this.renderizar(true);
    }
    if (n.length < 2) return this.falhar(T.assuntoCurto);
    this.entendeu();
    // O atendimento humano segue as mesmas restrições do canal.
    const bloqueados = temasNaoPermitidos(n, this.ctx.perfil, this.ctx.negocio);
    if (bloqueados.length) return this.bloquear(bloqueados);
    return this.solicitarHumano("contato", texto.slice(0, 500));
  }

  private casarOpcao(n: string): Casamento {
    const p = this.s.pergunta;
    if (!p || p.tipo !== "opcoes") return { tipo: "nenhum" };
    const num = /^(?:opcao |numero )?(\d{1,2})$/.exec(n);
    if (num) {
      const o = p.opcoes.find((x) => x.numero === Number(num[1]));
      return o ? { tipo: "ok", valor: o.valor } : { tipo: "numero_invalido" };
    }
    const aliases = this.aliasesDaEtapa();
    const termos = (valor: string, rotulo: string) => [normalizar(rotulo), ...(aliases[valor] ?? []).map(normalizar)];
    const exatas = p.opcoes.filter((o) => termos(o.valor, o.rotulo).includes(n));
    if (exatas.length === 1) return { tipo: "ok", valor: exatas[0]!.valor };
    if (exatas.length > 1) return { tipo: "nenhum" };
    // "sim, quero", "por ligação": o termo aparece como palavra inteira. Frase com negação ou que
    // menciona mais de uma opção ("manhã ou tarde") não escolhe nada.
    if (/\bnao\b/.test(n)) return { tipo: "nenhum" };
    const mencionadas = p.opcoes.filter((o) =>
      termos(o.valor, o.rotulo).some((t) => t.length >= 3 && new RegExp(`\\b${t}\\b`).test(n)),
    );
    return mencionadas.length === 1 ? { tipo: "ok", valor: mencionadas[0]!.valor } : { tipo: "nenhum" };
  }

  private aliasesDaEtapa(): Record<string, string[]> {
    const n = this.ctx.negocio;
    if (this.s.etapa === "coleta_contato") return Object.fromEntries(n.preferenciasContato.map((o) => [o.valor, o.aliases]));
    if (this.s.etapa === "coleta_periodo") return Object.fromEntries(n.periodos.map((o) => [o.valor, o.aliases]));
    return ALIASES[this.s.etapa] ?? {};
  }

  // ---------------------------------------------------------------- decisões

  private selecionar(valor: string): void {
    switch (this.s.etapa) {
      case "menu":
      case "esclarecimento":
        return this.abrirModulo(valor as ModuloId);
      case "servico":
        if (valor !== "solicitar") return this.irMenu();
        return this.avancar(this.nome() ? "coleta_contato" : "coleta_nome");
      case "coleta_contato":
        this.s.dados.preferenciaContato = valor;
        return this.avancar("coleta_periodo");
      case "coleta_periodo":
        this.s.dados.periodo = valor;
        this.s.dados.horarioTexto = undefined;
        return this.avancar("confirmacao");
      case "confirmacao":
        if (valor === "confirmar") return this.concluir();
        if (valor === "corrigir") {
          this.s.dados = {};
          return this.avancar("coleta_nome");
        }
        this.dizer(T.solicitacaoCancelada);
        return this.irMenu();
      case "oferta_humano":
        if (valor === "humano") {
          return this.solicitarHumano("fallback", "A assistente não entendeu as mensagens e o contato aceitou falar com a Janiere");
        }
        return this.irMenu();
      case "confirmar_cancelamento":
        if (valor === "sim") return this.registrarCancelamento("Contato confirmou que quer cancelar um atendimento combinado");
        this.dizer(T.semCancelamento);
        return this.irLivre();
      default:
        return this.irMenu();
    }
  }

  private rotearModulos(modulos: ModuloId[]): void {
    const permitidos = modulos.filter((m) => this.permitido(m));
    const bloqueados = modulos.filter((m) => !this.permitido(m));
    if (!permitidos.length) return this.bloquear(bloqueados);
    if (bloqueados.length) {
      this.efeitos.push({ tipo: "modulo_bloqueado", modulos: bloqueados });
      this.dizer(T.outroAssuntoBloqueado);
    }
    if (permitidos.length === 1) return this.abrirModulo(permitidos[0]!);
    return this.avancar("esclarecimento", { candidatos: permitidos });
  }

  private abrirModulo(m: ModuloId): void {
    if (!this.permitido(m)) return this.bloquear([m]);
    if (ehServico(m)) {
      this.efeitos.push({ tipo: "interesse", modulo: m });
      return this.avancar("servico", { modulo: m });
    }
    if (m === "falar_janiere") return this.avancar("assunto_humano");
    this.dizer(T.fluxoNaoImplementado(m));
    return this.irMenu();
  }

  private bloquear(modulos: ModuloId[]): void {
    this.efeitos.push({ tipo: "modulo_bloqueado", modulos });
    this.dizer(T.bloqueado(this.visiveis()));
    return this.irMenu();
  }

  private solicitarHumano(origem: "contato" | "comando" | "fallback", motivo: string): void {
    this.efeitos.push({ tipo: "solicitar_humano", origem, motivo, resumo: this.resumo() });
    this.dizer(T.humanoRegistrado(this.ctx.negocio, foraDoExpediente(this.ctx.negocio, this.ctx.agora)));
    return this.irLivre();
  }

  private registrarCancelamento(evidencia: string): void {
    this.efeitos.push({ tipo: "pedido_cancelamento", evidencia: evidencia.slice(0, 200) });
    this.dizer(T.cancelamentoRegistrado);
    return this.irLivre();
  }

  private concluir(): void {
    const m = this.servicoAtual();
    const nome = this.nome();
    const pref = this.s.dados.preferenciaContato;
    if (!m) return this.irMenu();
    if (!nome) return this.avancar("coleta_nome");
    if (!pref) return this.avancar("coleta_contato");
    const n = this.ctx.negocio;
    this.efeitos.push({
      tipo: "registrar_solicitacao",
      modulo: m,
      dados: {
        nome,
        preferenciaContato: pref,
        periodo: this.s.dados.periodo ?? null,
        horarioTexto: this.s.dados.horarioTexto ?? null,
      },
    });
    this.dizer(T.concluido(n, { nome, servico: DEFINICOES[m].emFrase, contato: rotuloDe(n.preferenciasContato, pref) }));
    return this.irLivre();
  }

  private falhar(dica?: string): void {
    this.s.falhas += 1;
    if (this.s.falhas >= 2 && this.s.etapa !== "oferta_humano") {
      this.s.falhas = 0;
      this.dizer(T.naoEntendiOferta);
      return this.avancar("oferta_humano");
    }
    const p = this.s.pergunta;
    if (this.s.etapa === "livre" || !p) {
      this.dizer(T.naoEntendi);
      return this.irMenu();
    }
    if (p.tipo === "texto") {
      // A dica já é a nova pergunta; a pergunta pendente (e seu id) continua a mesma.
      this.dizer(dica ?? T.naoEntendi);
      return this.descarregar();
    }
    this.dizer(T.naoEntendiOpcoes(p.opcoes.length));
    return this.renderizar(true);
  }

  // ---------------------------------------------------------------- navegação

  private avancar(etapa: Etapa, extra?: { modulo?: ModuloId; candidatos?: ModuloId[] }): void {
    if (this.s.etapa !== "livre") {
      this.s.historico.push({ etapa: this.s.etapa, modulo: this.s.modulo, candidatos: this.s.candidatos });
      if (this.s.historico.length > LIMITE_HISTORICO) this.s.historico.shift();
    }
    this.s.etapa = etapa;
    if (extra?.modulo) this.s.modulo = extra.modulo;
    this.s.candidatos = extra?.candidatos;
    return this.renderizar(false);
  }

  private voltar(): void {
    const anterior = this.s.historico.pop();
    if (!anterior) return this.irMenu();
    this.s.etapa = anterior.etapa;
    this.s.modulo = anterior.modulo;
    this.s.candidatos = anterior.candidatos;
    return this.renderizar(false);
  }

  private irMenu(): void {
    this.s.etapa = "menu";
    this.s.modulo = undefined;
    this.s.candidatos = undefined;
    this.s.historico = [];
    this.s.dados = {};
    return this.renderizar(false);
  }

  private irLivre(): void {
    this.s.etapa = "livre";
    this.s.modulo = undefined;
    this.s.candidatos = undefined;
    this.s.historico = [];
    this.s.dados = {};
    this.s.pergunta = null;
    return this.descarregar();
  }

  private entendeu(): void {
    this.s.falhas = 0;
  }

  // ---------------------------------------------------------------- saída

  private renderizar(reaproveitar: boolean): void {
    const n = this.ctx.negocio;
    const m = this.s.modulo ?? null;
    switch (this.s.etapa) {
      case "livre":
        this.s.pergunta = null;
        return this.descarregar();
      case "menu":
        return this.perguntar(T.menu, this.visiveis().map((x) => ({ valor: x, rotulo: DEFINICOES[x].titulo })), null, reaproveitar);
      case "esclarecimento":
        return this.perguntar(
          T.esclarecimento,
          (this.s.candidatos ?? []).map((x) => ({ valor: x, rotulo: DEFINICOES[x].titulo })),
          null,
          reaproveitar,
        );
      case "servico": {
        const servico = this.servicoAtual();
        if (!servico) return this.irMenu();
        return this.perguntar(
          T.servico(n, servico),
          [
            { valor: "solicitar", rotulo: T.opcaoSolicitar },
            { valor: "menu", rotulo: T.opcaoMenu },
          ],
          servico,
          reaproveitar,
        );
      }
      case "coleta_nome":
        return this.perguntarTexto(T.perguntaNome, m, reaproveitar);
      case "coleta_contato":
        return this.perguntar(T.perguntaContato(), n.preferenciasContato, m, reaproveitar);
      case "coleta_periodo":
        return this.perguntar(T.perguntaPeriodo, n.periodos, m, reaproveitar);
      case "confirmacao":
        return this.perguntar(
          T.confirmacao(this.linhasResumo()),
          [
            { valor: "confirmar", rotulo: T.opcaoConfirmar },
            { valor: "corrigir", rotulo: T.opcaoCorrigir },
            { valor: "cancelar", rotulo: T.opcaoCancelar },
          ],
          m,
          reaproveitar,
        );
      case "assunto_humano":
        return this.perguntarTexto(T.perguntaAssunto, null, reaproveitar);
      case "oferta_humano":
        return this.perguntar(
          T.ofertaHumano,
          [
            { valor: "humano", rotulo: T.opcaoHumanoSim },
            { valor: "menu", rotulo: T.opcaoHumanoMenu },
          ],
          null,
          reaproveitar,
        );
      case "confirmar_cancelamento":
        return this.perguntar(
          T.perguntaCancelamento,
          [
            { valor: "sim", rotulo: T.opcaoSim },
            { valor: "nao", rotulo: T.opcaoNao },
          ],
          null,
          reaproveitar,
        );
    }
  }

  private perguntar(texto: string, opcoes: { valor: string; rotulo: string }[], modulo: ModuloId | null, reaproveitar: boolean) {
    const numeradas = opcoes.map((o, i) => ({ numero: i + 1, valor: o.valor, rotulo: o.rotulo }));
    const id = this.idPergunta("opcoes", numeradas, reaproveitar);
    this.s.pergunta = { id, tipo: "opcoes", opcoes: numeradas };
    this.respostas.push({
      texto: this.consumirBuffer(texto),
      opcoes: numeradas.map((o) => ({ id: idAcao(id, o.numero), numero: o.numero, rotulo: o.rotulo })),
      modulo,
    });
  }

  private perguntarTexto(texto: string, modulo: ModuloId | null, reaproveitar: boolean) {
    const id = this.idPergunta("texto", [], reaproveitar);
    this.s.pergunta = { id, tipo: "texto", opcoes: [] };
    this.respostas.push({ texto: this.consumirBuffer(texto), opcoes: [], modulo });
  }

  /** Reaproveita o id só quando a mesma pergunta é repetida com as mesmas opções. */
  private idPergunta(tipo: "opcoes" | "texto", opcoes: { numero: number; valor: string; rotulo: string }[], reaproveitar: boolean) {
    const atual = this.s.pergunta;
    if (reaproveitar && atual && atual.tipo === tipo && JSON.stringify(atual.opcoes) === JSON.stringify(opcoes)) return atual.id;
    this.s.sequencia += 1;
    return this.s.sequencia;
  }

  private dizer(texto: string): void {
    this.buffer.push(texto);
  }

  private consumirBuffer(texto: string): string {
    const corpo = [...this.buffer, texto].join("\n\n");
    this.buffer = [];
    return corpo;
  }

  private descarregar(): void {
    if (!this.buffer.length) return;
    this.respostas.push({ texto: this.buffer.join("\n\n"), opcoes: [], modulo: null });
    this.buffer = [];
  }

  // ---------------------------------------------------------------- auxiliares

  private permitido(m: ModuloId): boolean {
    return avaliarModulo(this.ctx.perfil, this.ctx.negocio, m).permitido;
  }

  private visiveis(): ModuloId[] {
    return modulosVisiveis(this.ctx.perfil, this.ctx.negocio);
  }

  private servicoAtual(): ServicoId | null {
    const m = this.s.modulo;
    return m && ehServico(m) ? m : null;
  }

  private nome(): string | null {
    return this.s.dados.nome ?? this.ctx.contato.nome;
  }

  private linhasResumo(): string[] {
    const n = this.ctx.negocio;
    const m = this.servicoAtual();
    const d = this.s.dados;
    return [
      m ? `Atendimento: ${DEFINICOES[m].titulo}` : null,
      `Nome: ${this.nome() ?? "—"}`,
      d.preferenciaContato ? `Contato: ${rotuloDe(n.preferenciasContato, d.preferenciaContato)}` : null,
      d.periodo ? `Período: ${rotuloDe(n.periodos, d.periodo)}` : d.horarioTexto ? `Horário preferido: ${d.horarioTexto}` : null,
    ].filter((l): l is string => l !== null);
  }

  /** Resumo para a equipe: só dados da conversa, mais as restrições do canal. */
  private resumo(): string {
    const restritos = (Object.keys(DEFINICOES) as ModuloId[]).filter((m) => !this.permitido(m));
    const m = this.s.modulo;
    return [
      `Canal: ${this.ctx.perfil.nome}`,
      `Etapa em que estava: ${this.s.etapa}`,
      m ? `Fluxo: ${DEFINICOES[m].titulo}` : null,
      ...(this.s.etapa === "livre" ? [] : this.linhasResumo().filter((l) => !l.startsWith("Atendimento:"))),
      restritos.length
        ? `Restrições deste canal (valem também para o atendimento humano): não tratar ${restritos.map((x) => DEFINICOES[x].titulo).join("; ")}`
        : null,
    ]
      .filter((l): l is string => l !== null)
      .join("\n");
  }
}

function rotuloDe(lista: { valor: string; rotulo: string }[], valor: string): string {
  return lista.find((o) => o.valor === valor)?.rotulo ?? valor;
}

export function extrairNome(texto: string): string | null {
  let t = texto.trim().replace(/\s+/g, " ");
  t = t.replace(/^(oi+|ol[aá]|bom dia|boa tarde|boa noite)[\s,!.]*/iu, "");
  t = t.replace(/^(meu nome (é|e)|me chamo|pode me chamar de|eu sou|sou|aqui (é|e))\s+((o|a)\s+)?/iu, "");
  t = t.replace(/[.!,;]+$/u, "").trim();
  if (!/^\p{L}[\p{L}'. -]{1,59}$/u.test(t)) return null;
  if (t.split(" ").length > 5) return null;
  if ((t.match(/\p{L}/gu) ?? []).length < 2) return null;
  return capitalizarNome(t);
}
