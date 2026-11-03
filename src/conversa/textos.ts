import { servicoApresentavel, type ConfigNegocio } from "../config/negocio.js";
import { DEFINICOES, type ModuloId, type ServicoId } from "../dominio/modulos.js";
import { formatarReais, juntarLista } from "../lib/texto.js";

/**
 * Todos os textos fixos da assistente. Regras de persona (docs/fluxos.md):
 * assistente virtual da Janiere (nunca "sou a Janiere"), uma pergunta por vez, poucos emojis,
 * nenhum valor, prazo ou disponibilidade que não venha da configuração aprovada.
 */

const MARCA_DEMO = "[dado demonstrativo]";
const demo = (negocio: ConfigNegocio, texto: string) => (negocio.demonstrativo ? `${MARCA_DEMO} ${texto}` : texto);

export const T = {
  boasVindas: (n: ConfigNegocio) =>
    `Olá! Eu sou a assistente virtual da ${n.profissional.nome}, ${n.profissional.apresentacao}. 😊\n` +
    "A qualquer momento, digite MENU para ver as opções ou HUMANO para falar com a Janiere.",
  menu: "Como posso te ajudar? Escolha uma opção ou escreva o que você procura:",
  naoEntendi: "Desculpe, não entendi.",
  naoEntendiOpcoes: (max: number) => `Desculpe, não entendi. Responda com um número de 1 a ${max}.`,
  naoEntendiOferta: "Desculpe, ainda não consegui entender.",
  opcaoAntiga: "Essa opção é de uma mensagem anterior. Vamos continuar daqui:",
  continuar: "Oi! Vamos continuar de onde paramos.",
  deNada: "Por nada! Se precisar de algo, é só digitar MENU.",
  midia: "Por enquanto eu consigo ler apenas mensagens de texto. Pode me escrever sua dúvida?",

  bloqueado: (permitidos: ModuloId[]) =>
    "Esse assunto não é atendido por este canal." +
    (permitidos.length ? ` Por aqui eu posso ajudar com ${juntarLista(permitidos.map((m) => DEFINICOES[m].emFrase))}.` : ""),
  outroAssuntoBloqueado: "O outro assunto que você mencionou não é atendido por este canal.",
  fluxoNaoImplementado: (m: ModuloId) =>
    `[SIMULAÇÃO] O fluxo “${DEFINICOES[m].titulo}” ainda não foi implementado nesta etapa. Nada foi registrado.`,

  esclarecimento: "Só para confirmar: sobre qual destes assuntos você quer saber?",

  servico: (n: ConfigNegocio, id: ServicoId) => {
    const s = n.servicos[id];
    const linhas = [`*${s.titulo}*`];
    const apresentavel = servicoApresentavel(n, s);
    linhas.push(
      apresentavel && s.formato ? demo(n, s.formato) : "Os detalhes do formato são explicados diretamente pela Janiere.",
    );
    linhas.push(
      apresentavel && s.preco
        ? demo(n, `Valor: ${formatarReais(s.preco.valorCentavos)}${s.preco.observacao ? ` (${s.preco.observacao})` : ""}.`)
        : "O valor é informado diretamente pela Janiere.",
    );
    linhas.push("A avaliação e as orientações individuais são feitas pela própria Janiere, no atendimento.");
    linhas.push("", "Quer que eu registre uma solicitação de atendimento para ela entrar em contato?");
    return linhas.join("\n");
  },
  opcaoSolicitar: "Sim, quero solicitar",
  opcaoMenu: "Voltar ao menu",

  perguntaNome: "Ótimo! Como posso te chamar?",
  nomeInvalido: "Pode me dizer só o seu nome? Por exemplo: Ana.",
  perguntaContato: () => "Como você prefere que a Janiere entre em contato?",
  perguntaPeriodo: "Qual período do dia é melhor para esse contato?",
  confirmacao: (linhas: string[]) => ["Confere se está tudo certo:", ...linhas.map((l) => `• ${l}`)].join("\n"),
  opcaoConfirmar: "Confirmar",
  opcaoCorrigir: "Corrigir dados",
  opcaoCancelar: "Cancelar",
  solicitacaoCancelada: "Tudo bem, não registrei a solicitação.",
  fluxoCancelado: "Tudo bem, cancelei este pedido.",

  concluido: (n: ConfigNegocio, p: { nome: string; servico: string; contato: string }) =>
    `Pronto, ${p.nome}! Registrei sua solicitação de ${p.servico} e encaminhei para a Janiere. ` +
    `Ela vai entrar em contato pelo meio que você escolheu (${p.contato.toLowerCase()}) para combinar o horário — ` +
    "o horário só fica confirmado depois que ela falar com você." +
    (n.atendimentoHumano.prazoRetorno ? ` ${demo(n, `Prazo de retorno: ${n.atendimentoHumano.prazoRetorno}.`)}` : "") +
    "\nSe precisar de mais alguma coisa, é só digitar MENU.",

  perguntaAssunto: "Claro! Sobre o que você gostaria de falar com a Janiere? Pode resumir em poucas palavras.",
  assuntoCurto: "Pode me contar em poucas palavras qual é o assunto?",
  ofertaHumano: "Quer falar com a Janiere?",
  opcaoHumanoSim: "Sim, falar com ela",
  opcaoHumanoMenu: "Ver o menu",

  humanoRegistrado: (n: ConfigNegocio, foraDoExpediente: boolean) =>
    "Certo! Registrei seu pedido para falar com a Janiere e avisei a equipe." +
    (foraDoExpediente ? ` ${demo(n, "No momento estamos fora do horário de atendimento.")}` : "") +
    (n.atendimentoHumano.prazoRetorno ? ` ${demo(n, `Prazo de retorno: ${n.atendimentoHumano.prazoRetorno}.`)}` : "") +
    " Enquanto isso, as respostas automáticas ficam pausadas nesta conversa.",

  descadastrado:
    "Pronto, você não vai mais receber mensagens de acompanhamento ou novidades por aqui. " +
    "Se precisar de atendimento, é só mandar uma mensagem.",
  perguntaCancelamento: "Você quer cancelar um atendimento que já combinou com a Janiere?",
  opcaoSim: "Sim",
  opcaoNao: "Não",
  cancelamentoRegistrado:
    "Certo, registrei seu pedido de cancelamento e encaminhei para a Janiere. Ela vai ver o seu pedido e falar com você.",
  semCancelamento: "Tudo bem! Se precisar de algo, é só digitar MENU.",
};

/** Está fora do expediente configurado? Sem expediente configurado, nunca afirma que está fora. */
export function foraDoExpediente(n: ConfigNegocio, agora: Date): boolean {
  const exp = n.atendimentoHumano.expediente;
  if (!exp) return false;
  const partes = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Sao_Paulo",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(agora);
  const valor = (t: string) => partes.find((p) => p.type === t)?.value ?? "";
  const dia = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(valor("weekday"));
  const minutos = Number(valor("hour")) * 60 + Number(valor("minute"));
  const [hi, mi] = exp.inicio.split(":").map(Number) as [number, number];
  const [hf, mf] = exp.fim.split(":").map(Number) as [number, number];
  return !exp.diasSemana.includes(dia) || minutos < hi * 60 + mi || minutos >= hf * 60 + mf;
}
