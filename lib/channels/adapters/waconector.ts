/**
 * Adapter waconector — multi-provider de APIs não-oficiais de WhatsApp.
 *
 * Usa a biblioteca `waconector` (https://github.com/alltomatos/waconector) como
 * camada de abstração sobre EvoAPI, Z-API, Whapi, WAHA e outras APIs não-oficiais.
 * O backend específico é config via env var (`WACONECTOR_BACKEND`), não um
 * provider distinto no clinicCRM — todos compartilham as mesmas capabilities.
 *
 * ─── Por que este adapter existe ────────────────────────────────────────────
 *
 * O clinicCRM já fala WAHA direto (adapter `waha.ts`). Mas o usuário opera EvoAPI
 * na VPS, e quer a opção de trocar de provider sem reescrever código. O waconector
 * entrega um contrato único sobre 9 backends não-oficiais; este adapter traduz
 * o `ChannelAdapter` do clinicCRM para esse contrato.
 *
 * ─── O que este arquivo NÃO faz ─────────────────────────────────────────────
 *
 * Não decide se pode enviar (janela, cap, throttle) — isso é da cadeia
 * `before_send`. Não conhece templates — APIs não-oficiais não têm. Não consulta
 * banco — credencial vem do env (piloto de instância única); multi-instância por
 * sessão é extensão futura, seguindo o padrão do `meta/credentials.ts`.
 *
 * ─── sessionRef no piloto ──────────────────────────────────────────────────
 *
 * No WAHA, `sessionRef` é o nome da sessão (um container, várias sessões). No
 * EvoAPI, cada instância tem seu próprio `apiKey` — o `sessionRef` (nome da
 * instância) é informativo hoje, porque o adapter do waconector resolve a
 * instância a partir do `apiKey`. Quando migrarmos para multi-instância por sessão,
 * o `apiKey` virá da linha de `channel_sessions` (como o Meta Cloud faz com
 * `meta_token_encrypted`), e o `sessionRef` voltará a ser a chave de lookup.
 */
import { resolveWahaChatId } from "@/lib/waha/send";
import type { FetchedMedia } from "@/lib/messaging/media/types";
import { logger } from "@/lib/logger";
import { DETALHE_CREDENCIAL_RECUSADA } from "../health";
import type {
  ChannelAdapter,
  ChannelHealth,
  OutboundEnvelope,
  RecipientInput,
} from "../types";

// Import dinâmico para não quebrar o boot quando o waconector não está em uso
// (o pacote pode não estar instalado em ambientes que só usam WAHA/Meta).
type WaConnector = {
  messages: {
    sendText(input: { to: string; text: string; quotedId?: string }): Promise<{ id: string }>;
    sendMedia(input: {
      to: string;
      media: { kind: string; url: string; mimeType?: string; filename?: string };
      caption?: string;
    }): Promise<{ id: string }>;
    sendContactCard(input: {
      to: string;
      contactName: string;
      contactPhone: string;
    }): Promise<{ id: string }>;
    download(input: { messageId: string; raw?: unknown }): Promise<{
      base64: string;
      mimeType?: string;
      filename?: string;
      raw: unknown;
    }>;
  };
  presence: {
    setTyping(input: { to: string; state: "composing" | "recording" | "paused" }): Promise<void>;
  };
  instance: {
    status(): Promise<{ state: string; raw: unknown }>;
  };
  contacts: {
    getProfilePicture(chatId: string): Promise<{ url?: string; raw: unknown }>;
  };
};

// ─── Connector lazy singleton (piloto: instância única via env) ──────────────

let cachedConnector: WaConnector | null = null;
let cachedBackend: string | null = null;

/**
 * Reset do cache do connector — usado por testes para isolar entre casos.
 * Não exportado na interface pública; só acessível via `import` direto.
 */
export function __resetWaconectorCache(): void {
  cachedConnector = null;
  cachedBackend = null;
}

/**
 * Cria o connector waconector na primeira chamada e reutiliza nas subsequentes.
 *
 * Retorna `null` quando o waconector não está configurado (env vars ausentes) —
 * o chamador trata como noop, não como erro. Mesmo critério do `getWahaClient()`.
 *
 * O backend (evolution/zapi/whapi/...) é lido do env. Hoje só `evolution` está
 * implementado aqui; adicionar outro é um import + um case.
 */
async function getWaconectorConnector(): Promise<WaConnector | null> {
  // Lê process.env a cada chamada (não memoiza) — mesmo padrão do `getWahaClient()`,
  // para que `vi.stubEnv` funcione em testes e hot-swap de env em dev.
  const baseUrl = process.env.WACONECTOR_BASE_URL;
  const apiKey = process.env.WACONECTOR_API_KEY;
  if (!baseUrl || !apiKey) return null;

  const backend = process.env.WACONECTOR_BACKEND || "evolution";

  // Recria se o backend mudou (hot-swap de env em dev).
  if (cachedConnector && cachedBackend === backend) return cachedConnector;

  try {
    // Import dinâmico: se o pacote não estiver instalado, o boot não quebra.
    const waconector = await import("waconector");

    let connector: WaConnector | null = null;

    if (backend === "evolution") {
      const evolutionMod = await import("waconector/evolution");
      const adapter = evolutionMod.evolution({ baseUrl, apiKey });
      connector = waconector.createConnector(adapter) as unknown as WaConnector;
    } else {
      // Backend não implementado ainda — loga e devolve null (noop).
      logger.warn("waconector_backend_nao_implementado", { backend });
      return null;
    }

    cachedConnector = connector;
    cachedBackend = backend;
    return connector;
  } catch (err) {
    logger.error("waconector_init_falhou", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// ─── Mapeamento de kind ─────────────────────────────────────────────────────

/**
 * `OutboundKind` do clinicCRM → `MediaKind` do waconector.
 *
 * `text`, `location`, `contact`, `template` não são mídia — o chamador decide
 * o caminho antes de chegar aqui. `sticker` é mídia como qualquer outra.
 */
function mediaKindFor(kind: string): "image" | "video" | "audio" | "document" | "sticker" {
  switch (kind) {
    case "image":
      return "image";
    case "video":
      return "video";
    case "audio":
      return "audio";
    case "sticker":
      return "sticker";
    case "document":
    default:
      return "document";
  }
}

// ─── O adapter ──────────────────────────────────────────────────────────────

export const waconectorAdapter: ChannelAdapter = {
  provider: "waconector",

  /**
   * Reusa `resolveWahaChatId`: o endereço é semântica do WhatsApp (JID `@c.us`,
   * `@lid`, `@g.us`), não do provider. O waconector normaliza o chatId no
   * connector, mas o CRM precisa resolver ANTES (o envelope já chega com `to`).
   */
  resolveRecipient(input: RecipientInput): string | null {
    return resolveWahaChatId(input);
  },

  /**
   * Sem env de waconector → canal não configurado (noop). Mesmo critério do
   * WAHA: a UI mostra banner de "container não está no ar", não trava o produto.
   */
  isConfigured(): boolean {
    return Boolean(process.env.WACONECTOR_BASE_URL && process.env.WACONECTOR_API_KEY);
  },

  codes: {
    notConfigured: "waconector_not_configured",
    sendFailed: "waconector_error",
    unknownError: "waconector_unknown",
  },

  /**
   * Envia texto, mídia ou cartão de contato.
   *
   * O waconector devolve `SentMessage` com `id` direto — sem o parsing de shape
   * que o WAHA exige (string plana vs `_serialized` vs `key.id`). A normalização
   * de ID é trabalho do waconector, não nosso.
   */
  async send(envelope: OutboundEnvelope): Promise<{ externalId: string | null }> {
    const wa = await getWaconectorConnector();
    // Sem env → noop, não erro. Mesmo comportamento do adapter WAHA.
    if (!wa) return { externalId: null };

    try {
      let res: { id: string };

      if (envelope.kind === "contact" && envelope.contact) {
        await envelope.beforeSend?.();
        res = await wa.messages.sendContactCard({
          to: envelope.to,
          contactName: envelope.contact.fullName,
          contactPhone: envelope.contact.phoneNumber,
        });
      } else if (envelope.media) {
        await envelope.beforeSend?.();
        res = await wa.messages.sendMedia({
          to: envelope.to,
          media: {
            kind: mediaKindFor(envelope.kind),
            url: envelope.media.url,
            mimeType: envelope.media.mime,
            ...(envelope.media.filename ? { filename: envelope.media.filename } : {}),
          },
          ...(envelope.media.caption ? { caption: envelope.media.caption } : {}),
        });
      } else {
        await envelope.beforeSend?.();
        res = await wa.messages.sendText({
          to: envelope.to,
          text: envelope.body ?? "",
          ...(envelope.replyToExternalId ? { quotedId: envelope.replyToExternalId } : {}),
        });
      }

      return { externalId: res.id };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "erro_desconhecido";
      throw new Error(`waconector_error: ${msg}`);
    }
  },

  /**
   * "digitando…" no aparelho do cliente. NOOP sem env — mesmo critério do `send`:
   * indicador decorativo não pode travar o produto numa instalação sem container.
   */
  async signalTyping(input: {
    sessionRef: string;
    recipient: string;
  }): Promise<void> {
    const wa = await getWaconectorConnector();
    if (!wa) return;
    try {
      await wa.presence.setTyping({ to: input.recipient, state: "composing" });
    } catch {
      // Indicador é decoração: engolir falha é o critério do adapter WAHA também.
    }
  },

  /**
   * Pergunta ao transporte se a conexão está de pé.
   *
   * Mesma estrutura de três desfechos do adapter WAHA:
   *   - respondeu com estado → verdade do momento;
   *   - erro de credencial (401/403) → reachable:false, detail específico;
   *   - qualquer outro erro → reachable:false, não sabemos.
   */
  async checkHealth(input: { sessionRef: string }): Promise<ChannelHealth> {
    const wa = await getWaconectorConnector();
    if (!wa) return { reachable: false, status: null, detail: "transporte_nao_configurado" };

    try {
      const r = await wa.instance.status();
      return { reachable: true, status: r.state ?? null, detail: null };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "erro_desconhecido";
      // 401/403 → credencial recusada (mesmo diagnóstico do WAHA).
      if (msg.includes("401") || msg.includes("403")) {
        return { reachable: false, status: null, detail: DETALHE_CREDENCIAL_RECUSADA };
      }
      return { reachable: false, status: null, detail: msg.slice(0, 200) };
    }
  },

  /**
   * URL da foto de perfil do contato. O waconector devolve `{ url?: string }` —
   * ausente quando não há foto ou privacidade está fechada.
   */
  async fetchProfilePictureUrl(input: {
    sessionRef: string;
    recipient: string;
  }): Promise<string | null> {
    const wa = await getWaconectorConnector();
    if (!wa) return null;
    try {
      const r = await wa.contacts.getProfilePicture(input.recipient);
      return r.url ?? null;
    } catch {
      return null;
    }
  },

  /**
   * Baixa a mídia que o cliente mandou, para persistir os bytes.
   *
   * O waconector devolve `{ base64, mimeType? }` — converte para `FetchedMedia`
   * (`Buffer` + `mime`), que é o tipo que o worker de persistência consome.
   */
  async fetchInboundMedia(input: {
    sessionRef: string;
    url: string;
    hintMime?: string | null;
  }): Promise<FetchedMedia> {
    const wa = await getWaconectorConnector();
    if (!wa) throw new Error("waconector_not_configured");

    // O `url` aqui é o `messageId` no contexto do waconector — o adapter do
    // Evolution resolve o download a partir do ID da mensagem, não de uma URL.
    // O chamador (worker de persistência) passa o que tem; o adapter traduz.
    const downloaded = await wa.messages.download({
      messageId: input.url,
    });

    const buffer = Buffer.from(downloaded.base64, "base64");
    return {
      buffer,
      mime: downloaded.mimeType ?? input.hintMime ?? "application/octet-stream",
    };
  },

  /**
   * Formas alternativas do mesmo ID de envio — para reconhecer o eco no webhook.
   *
   * O waconector normaliza IDs no connector, então o ID que volta pelo webhook
   * deve ser o mesmo que o envio devolveu. Ao contrário do WAHA (NOWEB é
   * assimétrico), não há composição `true_{chatId}_{bareId}` para desmontar.
   *
   * Devolve só o próprio ID — se o waconector provar simétrico na prática, este
   * método pode ser removido (o chamador cai no `externalId` direto).
   */
  echoExternalIds(input: { externalId: string; recipient: string }): string[] {
    return [input.externalId];
  },
};
