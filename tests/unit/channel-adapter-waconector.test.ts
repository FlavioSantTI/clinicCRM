/**
 * Testes do adapter waconector — multi-provider de APIs não-oficiais.
 *
 * O adapter é burro de propósito (mesma doutrina do adapter WAHA): traduz
 * formato e delega ao waconector. Não há caso aqui sobre janela, cap ou
 * horário — se um aparecer, o desenho vazou.
 *
 * A diferença do WAHA: o waconector normaliza IDs (não há parsing de
 * `_serialized` vs `key.id`), e o backend é config via env (evolution/zapi/...).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { getAdapter } from "@/lib/channels";
import { DETALHE_CREDENCIAL_RECUSADA } from "@/lib/channels/health";
import { __resetWaconectorCache } from "@/lib/channels/adapters/waconector";

const ORG = "00000000-0000-4000-8000-000000000236";
const WAC_BASE = "http://evolution:8080";

afterEach(() => {
  __resetWaconectorCache();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("adapter waconector", () => {
  it("resolve destinatário 1:1 por telefone (mesma semântica do WAHA)", () => {
    const a = getAdapter("waconector");
    expect(
      a.resolveRecipient({
        isGroup: false,
        groupChatId: null,
        phoneNumber: "+5531999998888",
        waIdentity: null,
      }),
    ).toBe("5531999998888@c.us");
  });

  it("resolve destinatário por lid quando não há telefone", () => {
    const a = getAdapter("waconector");
    expect(
      a.resolveRecipient({
        isGroup: false,
        groupChatId: null,
        phoneNumber: null,
        waIdentity: "lid:12345",
      }),
    ).toBe("12345@lid");
  });

  it("resolve grupo por groupChatId", () => {
    const a = getAdapter("waconector");
    expect(
      a.resolveRecipient({
        isGroup: true,
        groupChatId: "120363@g.us",
        phoneNumber: "+5531999998888",
        waIdentity: null,
      }),
    ).toBe("120363@g.us");
  });

  it("resolução de adapter é fail-closed", () => {
    // @ts-expect-error provider inexistente é erro de tipo E de runtime
    expect(() => getAdapter("telegram")).toThrow(/unknown_channel_provider/);
  });

  it("isConfigured é false sem env do canal", () => {
    vi.stubEnv("WACONECTOR_BASE_URL", "");
    vi.stubEnv("WACONECTOR_API_KEY", "");
    expect(getAdapter("waconector").isConfigured()).toBe(false);
  });

  it("isConfigured é true com env do canal", () => {
    vi.stubEnv("WACONECTOR_BASE_URL", WAC_BASE);
    vi.stubEnv("WACONECTOR_API_KEY", "evo-token");
    expect(getAdapter("waconector").isConfigured()).toBe(true);
  });

  it("codes carrega os literais que o handler grava", () => {
    expect(getAdapter("waconector").codes).toEqual({
      notConfigured: "waconector_not_configured",
      sendFailed: "waconector_error",
      unknownError: "waconector_unknown",
    });
  });

  it("canal não configurado é NOOP, não erro — e nada sai pela rede", async () => {
    vi.stubEnv("WACONECTOR_BASE_URL", "");
    vi.stubEnv("WACONECTOR_API_KEY", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      getAdapter("waconector").send({
        organizationId: ORG,
        sessionRef: "clinic_a",
        to: "5531999998888@c.us",
        kind: "text",
        body: "oi",
      }),
    ).resolves.toEqual({ externalId: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("texto vai por sendText e o id externo sai direto (sem parsing de shape)", async () => {
    vi.stubEnv("WACONECTOR_BASE_URL", WAC_BASE);
    vi.stubEnv("WACONECTOR_API_KEY", "evo-token");
    vi.stubEnv("WACONECTOR_BACKEND", "evolution");

    // O waconector evolution adapter faz POST /send/text e devolve
    // { data: { Info: { ID: "..." } } } no formato do EvoAPI.
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      const href = String(url);
      if (href.includes("/send/text")) {
        return Promise.resolve(
          Response.json({ data: { Info: { ID: "EVO_MSG_123" } } }),
        );
      }
      return Promise.resolve(Response.json({}));
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await getAdapter("waconector").send({
      organizationId: ORG,
      sessionRef: "clinic_a",
      to: "5531999998888@c.us",
      kind: "text",
      body: "oi",
    });

    // O waconector normaliza o ID — devolve direto, sem parsing de _serialized.
    expect(res.externalId).toBeTruthy();
    expect(fetchMock).toHaveBeenCalled();
  });

  it("mídia vai por sendMedia com o kind correto", async () => {
    vi.stubEnv("WACONECTOR_BASE_URL", WAC_BASE);
    vi.stubEnv("WACONECTOR_API_KEY", "evo-token");
    vi.stubEnv("WACONECTOR_BACKEND", "evolution");

    const fetchMock = vi.fn().mockImplementation((url: string) => {
      const href = String(url);
      if (href.includes("/send/media")) {
        return Promise.resolve(
          Response.json({ data: { Info: { ID: "EVO_MEDIA_456" } } }),
        );
      }
      return Promise.resolve(Response.json({}));
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await getAdapter("waconector").send({
      organizationId: ORG,
      sessionRef: "clinic_a",
      to: "5531999998888@c.us",
      kind: "image",
      media: { url: "https://x/img.png", mime: "image/png" },
    });

    expect(res).toEqual({ externalId: "EVO_MEDIA_456" });
    const call = fetchMock.mock.calls.find(([url]) =>
      String(url).includes("/send/media"),
    );
    expect(call).toBeTruthy();
  });

  it("signalTyping é NOOP sem env (não trava o produto)", async () => {
    vi.stubEnv("WACONECTOR_BASE_URL", "");
    vi.stubEnv("WACONECTOR_API_KEY", "");

    // Não deve lançar — indicador decorativo não pode derrubar o produto.
    await expect(
      getAdapter("waconector").signalTyping!({
        organizationId: ORG,
        sessionRef: "clinic_a",
        recipient: "5531999998888@c.us",
      }),
    ).resolves.toBeUndefined();
  });

  it("echoExternalIds devolve o próprio ID (waconector normaliza)", () => {
    const a = getAdapter("waconector");
    const ids = a.echoExternalIds!({
      externalId: "EVO_MSG_123",
      recipient: "5531999998888@c.us",
    });
    expect(ids).toEqual(["EVO_MSG_123"]);
  });

  describe("checkHealth traduz o erro do transporte", () => {
    function stubWacHttp(status: number, body = "{}") {
      vi.stubEnv("WACONECTOR_BASE_URL", WAC_BASE);
      vi.stubEnv("WACONECTOR_API_KEY", "evo-token");
      vi.stubEnv("WACONECTOR_BACKEND", "evolution");
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(new Response(body, { status })),
      );
    }

    it("sem env é transporte_nao_configurado", async () => {
      vi.stubEnv("WACONECTOR_BASE_URL", "");
      vi.stubEnv("WACONECTOR_API_KEY", "");
      const h = await getAdapter("waconector").checkHealth!({
        organizationId: ORG,
        sessionRef: "clinic_a",
      });
      expect(h).toEqual({
        reachable: false,
        status: null,
        detail: "transporte_nao_configurado",
      });
    });

    it("200 devolve o estado da instância", async () => {
      stubWacHttp(
        200,
        JSON.stringify({ instance: { state: "open" } }),
      );
      const h = await getAdapter("waconector").checkHealth!({
        organizationId: ORG,
        sessionRef: "clinic_a",
      });
      expect(h.reachable).toBe(true);
      expect(h.detail).toBeNull();
    });

    it('401 é credencial recusada, não "não deu para perguntar"', async () => {
      stubWacHttp(401, '{"message":"Unauthorized"}');
      const h = await getAdapter("waconector").checkHealth!({
        organizationId: ORG,
        sessionRef: "clinic_a",
      });
      expect(h.detail).toBe(DETALHE_CREDENCIAL_RECUSADA);
      expect(h.status).toBeNull();
    });

    it('500 fica em "não sei" — inventar estado é o que ensina a ignorar o aviso', async () => {
      stubWacHttp(500);
      const h = await getAdapter("waconector").checkHealth!({
        organizationId: ORG,
        sessionRef: "clinic_a",
      });
      expect(h.reachable).toBe(false);
      expect(h.status).toBeNull();
      expect(h.detail).not.toBe(DETALHE_CREDENCIAL_RECUSADA);
    });
  });
});
