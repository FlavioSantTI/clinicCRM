/**
 * Ingest do waconector — converte `CanonicalEvent` do waconector para
 * `WahaEnvelope` e reusa o pipeline de ingest do WAHA.
 *
 * ─── Por que reusar o pipeline do WAHA ──────────────────────────────────────
 *
 * O pipeline de ingest do WAHA (`lib/waha/ingest.ts`) é battle-tested com:
 *   - Resolução atômica de contato/conversa via RPC (fn_upsert_wa_contact)
 *   - Dedup por external_id (unique constraint, 23505)
 *   - Detecção de eco (fromMe = nosso próprio envio voltando)
 *   - Efeitos pós-entrada (pausar IA, handoff humano)
 *   - Sincronização de saúde da conexão
 *
 * Reescrever tudo isso para o waconector seria ~1000 linhas de código duplicado
 * com o mesmo risco que o WAHA já resolveu. Converter o formato e reusar é
 * ~100 linhas com zero risco de regressão.
 *
 * ─── O que este arquivo faz ────────────────────────────────────────────────
 *
 * 1. Recebe `CanonicalEvent[]` do waconector (já parseado pelo connector)
 * 2. Converte cada evento para `WahaEnvelope` (o formato que o WAHA usa)
 * 3. Chama `dispatchWahaEvent` — o mesmo pipeline do WAHA
 *
 * A conversão é uma tradução de formato, não de semântica: o WhatsApp é o
 * mesmo por baixo, só muda o vocabulário do provider.
 */
import { dispatchWahaEvent, type Admin } from "@/lib/waha/ingest";
import type { WahaEnvelope, WahaPayload } from "@/lib/waha/envelope";

/** Tipos canônicos do waconector (importados dinamicamente no inbound). */
interface WaMessageLike {
  id: string;
  chatId: string;
  from?: string;
  fromMe: boolean;
  timestamp: number;
  kind: string;
  text?: string;
  media?: { kind?: string; url?: string; mimeType?: string; id?: string } | null;
  quotedId?: string;
  raw: unknown;
}

interface CanonicalEventLike {
  type: string;
  provider: string;
  instanceId?: string;
  raw: unknown;
  message?: WaMessageLike;
  messageId?: string;
  chatId?: string;
  ack?: string;
  state?: string;
  qr?: string;
}

interface SessionLike {
  id: string;
  organization_id: string;
  is_warmup_complete?: boolean | null;
  warmup_started_at?: string | null;
}

/**
 * Mapeia `kind` do waconector para `type` do WAHA.
 *
 * O WAHA/NOWEB usa um vocabulário próprio ("chat" = texto, "ptt" = áudio, etc.).
 * O waconector usa um vocabulário mais limpo ("text", "audio", etc.). Esta
 * função traduz entre os dois.
 */
function kindToWahaType(kind: string): string {
  switch (kind) {
    case "text":
      return "chat";
    case "image":
      return "image";
    case "video":
      return "video";
    case "audio":
      return "ptt";
    case "document":
      return "document";
    case "sticker":
      return "sticker";
    case "location":
      return "location";
    case "contact":
      return "vcard";
    case "reaction":
      return "reaction";
    case "poll":
      return "poll";
    default:
      return "unknown";
  }
}

/**
 * Mapeia `ack` do waconector (string) para `ack` do WAHA (número).
 *
 * WAHA/NOWEB: 0=pending, 1=sent, 2=delivered, 3=read, 4=played.
 * waconector: "pending"|"sent"|"delivered"|"read"|"played"|"error".
 */
function ackToWahaNumber(ack: string): number {
  switch (ack) {
    case "pending":
      return 0;
    case "sent":
      return 1;
    case "delivered":
      return 2;
    case "read":
      return 3;
    case "played":
      return 4;
    default:
      return 0;
  }
}

/**
 * Converte uma `WaMessage` do waconector para `WahaPayload` do WAHA.
 *
 * Timestamp: waconector usa epoch em MILISSEGUNDOS; WAHA usa SEGUNDOS.
 * A divisão por 1000 é a tradução.
 */
function waMessageToPayload(msg: WaMessageLike): WahaPayload {
  const hasMedia = msg.media != null && (msg.media.url != null || msg.media.id != null);
  return {
    id: msg.id,
    // Para inbound (fromMe=false): `from` é quem mandou = msg.from ou msg.chatId.
    // Para outbound echo (fromMe=true): `from` é o destinatário = msg.chatId.
    // O WAHA usa `from` como o chatId da conversa em ambos os casos.
    from: msg.from ?? msg.chatId,
    to: msg.chatId,
    fromMe: msg.fromMe,
    body: msg.text ?? "",
    type: kindToWahaType(msg.kind),
    hasMedia,
    ack: 0,
    ackName: "",
    status: "",
    // waconector: epoch ms → WAHA: epoch seconds
    timestamp: Math.floor(msg.timestamp / 1000),
    mediaUrl: msg.media?.url ?? "",
    mimetype: msg.media?.mimeType ?? "",
    media: msg.media
      ? {
          url: msg.media.url ?? "",
          mimetype: msg.media.mimeType ?? "",
        }
      : undefined,
    _data: {
      // O `raw` do waconector carrega o payload original do provider (EvoAPI).
      // Vai em `_data.message` para que os helpers do WAHA (bodyOf, resolveMessageType)
      // possam fazer fallback se precisarem.
      message: msg.raw,
      notifyName: "",
      pushName: "",
    },
  };
}

/**
 * Converte um `CanonicalEvent` do waconector para `WahaEnvelope` do WAHA.
 *
 * Retorna `null` para eventos que o pipeline do WAHA não trata (group.update,
 * unknown) — o chamador ignora.
 */
export function canonicalToWahaEnvelope(
  event: CanonicalEventLike,
  sessionRef: string,
): WahaEnvelope | null {
  switch (event.type) {
    case "message.received":
    case "message.sent": {
      if (!event.message) return null;
      return {
        event: "message",
        session: sessionRef,
        payload: waMessageToPayload(event.message),
      };
    }
    case "message.ack": {
      return {
        event: "message.ack",
        session: sessionRef,
        payload: {
          id: event.messageId ?? "",
          from: event.chatId ?? "",
          to: "",
          fromMe: false,
          body: "",
          type: "",
          hasMedia: false,
          ack: event.ack ? ackToWahaNumber(event.ack) : 0,
          ackName: event.ack ?? "",
          status: "",
          timestamp: 0,
          mediaUrl: "",
          mimetype: "",
        },
      };
    }
    case "connection.update": {
      return {
        event: "session.status",
        session: sessionRef,
        payload: {
          id: "",
          from: "",
          to: "",
          fromMe: false,
          body: "",
          type: "",
          hasMedia: false,
          ack: 0,
          ackName: "",
          status: event.state ?? "",
          timestamp: 0,
          mediaUrl: "",
          mimetype: "",
        },
      };
    }
    default:
      // group.update, unknown, ou qualquer evento novo — o pipeline do WAHA
      // não tem handler para esses. Ignorar é seguro: o webhook já foi arquivado.
      return null;
  }
}

/**
 * Ingest completo: converte eventos canônicos e despacha pelo pipeline do WAHA.
 *
 * Esta é a função que o `waconectorInbound` em `lib/channels/inbound.ts` chama
 * depois de parsear o webhook com o connector do waconector.
 */
export async function ingestWaconectorEvents(
  admin: Admin,
  session: SessionLike,
  events: CanonicalEventLike[],
  sessionRef: string,
  requestId: string,
): Promise<{ ingeridos: number; ignorados: number; erros: number }> {
  let ingeridos = 0;
  let ignorados = 0;
  let erros = 0;

  for (const event of events) {
    const envelope = canonicalToWahaEnvelope(event, sessionRef);
    if (!envelope) {
      ignorados++;
      continue;
    }

    try {
      await dispatchWahaEvent(admin, session as never, envelope, requestId);
      ingeridos++;
    } catch (err) {
      erros++;
      // Loga mas não derruba: um evento ruim não pode parar o resto do lote.
      console.error(
        `[waconector.ingest] dispatch falhou para evento ${event.type}`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  return { ingeridos, ignorados, erros };
}
