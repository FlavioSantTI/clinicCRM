/**
 * Testes do ingest waconector — conversão de CanonicalEvent para WahaEnvelope
 * e despacho pelo pipeline do WAHA.
 *
 * A estratégia do ingest é REUSAR o pipeline do WAHA (dispatchWahaEvent).
 * Estes testes verificam que a conversão está correta: o WahaEnvelope
 * produzido tem os campos que o pipeline do WAHA espera.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

// Mocka o dispatchWahaEvent para não tocar o banco — só verifica que foi
// chamado com o envelope correto. vi.hoisted garante que o mock exista antes
// do vi.mock (que é hoisted para o topo do arquivo).
const { dispatchMock } = vi.hoisted(() => ({ dispatchMock: vi.fn() }));
vi.mock("@/lib/waha/ingest", () => ({
  dispatchWahaEvent: dispatchMock,
}));

// Mocka o audit (cadeia de import do ingest real).
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

import {
  canonicalToWahaEnvelope,
  ingestWaconectorEvents,
} from "@/lib/channels/waconector/ingest";

const SESSION_REF = "clinic_a";
const SESSION = {
  id: "sess-123",
  organization_id: "org-456",
};

/** Constrói uma WaMessage canônica do waconector. */
function waMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "EVO_MSG_001",
    chatId: "5531999998888@c.us",
    from: "5531999998888@c.us",
    fromMe: false,
    timestamp: 1695300000000, // epoch em MILISSEGUNDOS (waconector)
    kind: "text",
    text: "Olá, quero agendar",
    media: null,
    raw: { event: "messages.upsert", data: {} },
    ...overrides,
  };
}

/** Converte e já faz cast non-null — falha o teste se vier null quando não deveria. */
function toEnvelope(event: Record<string, unknown>): {
  event: string;
  session: string;
  payload: Record<string, unknown>;
} {
  const env = canonicalToWahaEnvelope(event as never, SESSION_REF);
  if (!env) throw new Error("envelope não deveria ser null");
  return env as { event: string; session: string; payload: Record<string, unknown> };
}

afterEach(() => {
  dispatchMock.mockReset();
});

describe("canonicalToWahaEnvelope — conversão de formato", () => {
  it("message.received vira WahaEnvelope event=message com fromMe=false", () => {
    const env = toEnvelope({
      type: "message.received",
      provider: "evolution",
      message: waMessage(),
      raw: {},
    });
    expect(env.event).toBe("message");
    expect(env.session).toBe(SESSION_REF);
    expect(env.payload.fromMe).toBe(false);
    expect(env.payload.id).toBe("EVO_MSG_001");
    expect(env.payload.from).toBe("5531999998888@c.us");
    expect(env.payload.body).toBe("Olá, quero agendar");
  });

  it("message.sent vira WahaEnvelope event=message com fromMe=true", () => {
    const env = toEnvelope({
      type: "message.sent",
      provider: "evolution",
      message: waMessage({ fromMe: true }),
      raw: {},
    });
    expect(env.event).toBe("message");
    expect(env.payload.fromMe).toBe(true);
  });

  it("timestamp em ms é convertida para segundos (waconector→WAHA)", () => {
    const env = toEnvelope({
      type: "message.received",
      provider: "evolution",
      message: waMessage(),
      raw: {},
    });
    // 1695300000000 ms → 1695300000 s
    expect(env.payload.timestamp).toBe(1695300000);
  });

  it("kind text → type chat (vocabulário do WAHA/NOWEB)", () => {
    const env = toEnvelope({
      type: "message.received",
      provider: "evolution",
      message: waMessage(),
      raw: {},
    });
    expect(env.payload.type).toBe("chat");
  });

  it("kind audio → type ptt (nota de voz no vocabulário do WAHA)", () => {
    const env = toEnvelope({
      type: "message.received",
      provider: "evolution",
      message: waMessage({ kind: "audio", text: "" }),
      raw: {},
    });
    expect(env.payload.type).toBe("ptt");
  });

  it("kind image → type image", () => {
    const env = toEnvelope({
      type: "message.received",
      provider: "evolution",
      message: waMessage({ kind: "image" }),
      raw: {},
    });
    expect(env.payload.type).toBe("image");
  });

  it("mídia preenche mediaUrl, mimetype e hasMedia", () => {
    const env = toEnvelope({
      type: "message.received",
      provider: "evolution",
      message: waMessage({
        kind: "image",
        media: { kind: "image", url: "https://cdn/img.png", mimeType: "image/png" },
      }),
      raw: {},
    });
    expect(env.payload.hasMedia).toBe(true);
    expect(env.payload.mediaUrl).toBe("https://cdn/img.png");
    expect(env.payload.mimetype).toBe("image/png");
  });

  it("message.ack vira WahaEnvelope event=message.ack com ack numérico", () => {
    const env = toEnvelope({
      type: "message.ack",
      provider: "evolution",
      messageId: "EVO_MSG_001",
      chatId: "5531999998888@c.us",
      ack: "delivered",
      raw: {},
    });
    expect(env.event).toBe("message.ack");
    expect(env.payload.id).toBe("EVO_MSG_001");
    // "delivered" → 2 (vocabulário numérico do WAHA)
    expect(env.payload.ack).toBe(2);
    expect(env.payload.ackName).toBe("delivered");
  });

  it("connection.update vira WahaEnvelope event=session.status", () => {
    const env = toEnvelope({
      type: "connection.update",
      provider: "evolution",
      state: "open",
      raw: {},
    });
    expect(env.event).toBe("session.status");
    expect(env.payload.status).toBe("open");
  });

  it("group.update é ignorado (retorna null — pipeline do WAHA não trata)", () => {
    const env = canonicalToWahaEnvelope(
      { type: "group.update", provider: "evolution", groupId: "120363@g.us", raw: {} } as never,
      SESSION_REF,
    );
    expect(env).toBeNull();
  });

  it("unknown é ignorado (retorna null)", () => {
    const env = canonicalToWahaEnvelope(
      { type: "unknown", provider: "evolution", raw: {}, reason: "no match" } as never,
      SESSION_REF,
    );
    expect(env).toBeNull();
  });

  it("message.received sem message retorna null (evento incompleto)", () => {
    const env = canonicalToWahaEnvelope(
      { type: "message.received", provider: "evolution", raw: {} },
      SESSION_REF,
    );
    expect(env).toBeNull();
  });
});

describe("ingestWaconectorEvents — despacho pelo pipeline do WAHA", () => {
  it("despacha message.received chamando dispatchWahaEvent", async () => {
    dispatchMock.mockResolvedValue(undefined);

    const result = await ingestWaconectorEvents(
      {} as never,
      SESSION as never,
      [
        {
          type: "message.received",
          provider: "evolution",
          message: waMessage(),
          raw: {},
        },
      ] as never[],
      SESSION_REF,
      "req-001",
    );

    expect(result.ingeridos).toBe(1);
    expect(result.ignorados).toBe(0);
    expect(result.erros).toBe(0);
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    // Verifica que o envelope passado tem o event correto
    const passed = dispatchMock.mock.calls[0]![2] as { event: string };
    expect(passed.event).toBe("message");
  });

  it("ignora group.update e unknown sem chamar dispatchWahaEvent", async () => {
    dispatchMock.mockResolvedValue(undefined);

    const result = await ingestWaconectorEvents(
      {} as never,
      SESSION as never,
      [
        { type: "group.update", provider: "evolution", groupId: "g@g.us", raw: {} } as never,
        { type: "unknown", provider: "evolution", raw: {} } as never,
      ] as never[],
      SESSION_REF,
      "req-002",
    );

    expect(result.ingeridos).toBe(0);
    expect(result.ignorados).toBe(2);
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("conta erros sem derrubar o lote inteiro", async () => {
    dispatchMock.mockRejectedValueOnce(new Error("db timeout"));
    dispatchMock.mockResolvedValueOnce(undefined);

    const result = await ingestWaconectorEvents(
      {} as never,
      SESSION as never,
      [
        {
          type: "message.received",
          provider: "evolution",
          message: waMessage(),
          raw: {},
        },
        {
          type: "message.received",
          provider: "evolution",
          message: waMessage({ id: "EVO_MSG_002" }),
          raw: {},
        },
      ] as never[],
      SESSION_REF,
      "req-003",
    );

    // 1 erro + 1 ingerido = lote não derrubado
    expect(result.ingeridos).toBe(1);
    expect(result.erros).toBe(1);
    expect(dispatchMock).toHaveBeenCalledTimes(2);
  });

  it("lote vazio devolve zeros", async () => {
    const result = await ingestWaconectorEvents(
      {} as never,
      SESSION as never,
      [] as never[],
      SESSION_REF,
      "req-004",
    );
    expect(result).toEqual({ ingeridos: 0, ignorados: 0, erros: 0 });
    expect(dispatchMock).not.toHaveBeenCalled();
  });
});
