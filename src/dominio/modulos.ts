/**
 * Mapa de referência do produto (menu original de 7 opções). Os identificadores são estáveis:
 * a numeração exibida em cada canal muda conforme a elegibilidade, os ids não.
 */
export const MODULOS = [
  "renda_extra",
  "distribuidor",
  "produtos",
  "equipe",
  "nutricao",
  "personal",
  "falar_janiere",
] as const;

export type ModuloId = (typeof MODULOS)[number];

export type Categoria = "negocio_herbalife" | "produtos_herbalife" | "servico_profissional" | "atendimento";

export interface DefinicaoModulo {
  /** Posição no menu de referência (1–7). */
  referencia: number;
  titulo: string;
  /** Título para linhas de lista interativa (limite de 24 caracteres no WhatsApp). */
  tituloCurto: string;
  /** Como o módulo aparece no meio de uma frase. */
  emFrase: string;
  categoria: Categoria;
}

export const DEFINICOES: Record<ModuloId, DefinicaoModulo> = {
  renda_extra: {
    referencia: 1,
    titulo: "Oportunidade de renda extra",
    tituloCurto: "Renda extra",
    emFrase: "oportunidade de renda extra",
    categoria: "negocio_herbalife",
  },
  distribuidor: {
    referencia: 2,
    titulo: "Quero ser distribuidor(a) Herbalife",
    tituloCurto: "Ser distribuidor(a)",
    emFrase: "ser distribuidor(a) Herbalife",
    categoria: "negocio_herbalife",
  },
  produtos: {
    referencia: 3,
    titulo: "Quero conhecer os produtos",
    tituloCurto: "Conhecer os produtos",
    emFrase: "produtos",
    categoria: "produtos_herbalife",
  },
  equipe: {
    referencia: 4,
    titulo: "Quero crescer e desenvolver minha equipe",
    tituloCurto: "Desenvolver equipe",
    emFrase: "desenvolvimento de equipe",
    categoria: "negocio_herbalife",
  },
  nutricao: {
    referencia: 5,
    titulo: "Nutricionista on-line",
    tituloCurto: "Nutricionista on-line",
    emFrase: "nutricionista on-line",
    categoria: "servico_profissional",
  },
  personal: {
    referencia: 6,
    titulo: "Personal Trainer on-line",
    tituloCurto: "Personal Trainer on-line",
    emFrase: "personal trainer on-line",
    categoria: "servico_profissional",
  },
  falar_janiere: {
    referencia: 7,
    titulo: "Falar diretamente com Janiere",
    tituloCurto: "Falar com a Janiere",
    emFrase: "falar diretamente com a Janiere",
    categoria: "atendimento",
  },
};

export const SERVICOS_PROFISSIONAIS = ["nutricao", "personal"] as const;
export type ServicoId = (typeof SERVICOS_PROFISSIONAIS)[number];

export const ehServico = (m: ModuloId): m is ServicoId => m === "nutricao" || m === "personal";
