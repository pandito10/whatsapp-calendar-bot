import test from "node:test";
import assert from "node:assert/strict";

test("sube media a Meta y envia documento por WhatsApp", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  process.env.WHATSAPP_VERIFY_TOKEN = "verify-token-test";
  process.env.WHATSAPP_PHONE_NUMBER_ID = "123456789";
  process.env.WHATSAPP_ACCESS_TOKEN = "whatsapp-token-test";
  process.env.DOCTOR_WHATSAPP_NUMBER = "5210000000000";
  process.env.AI_PROVIDER = "local";

  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith("/media")) {
      assert.equal(options.method, "POST");
      assert.equal(options.headers.Authorization, "Bearer whatsapp-token-test");
      assert.ok(options.body instanceof FormData);
      assert.equal(options.body.get("messaging_product"), "whatsapp");
      assert.ok(options.body.get("file"));
      return new Response(JSON.stringify({ id: "media-test-123" }), { status: 200 });
    }
    if (String(url).endsWith("/messages")) {
      const payload = JSON.parse(options.body);
      assert.equal(payload.to, "5214770000000");
      assert.equal(payload.type, "document");
      assert.equal(payload.document.id, "media-test-123");
      assert.equal(payload.document.filename, "resultado.pdf");
      assert.equal(payload.document.caption, "Resultado listo");
      return new Response(JSON.stringify({ messages: [{ id: "wamid.test" }] }), { status: 200 });
    }
    throw new Error(`Unexpected URL ${url}`);
  };

  try {
    const { sendWhatsAppMedia } = await import(`../src/whatsapp.js?media=${Date.now()}`);
    const result = await sendWhatsAppMedia(
      "5214770000000",
      {
        filename: "resultado.pdf",
        contentType: "application/pdf",
        buffer: Buffer.from("%PDF-test"),
        size: 9
      },
      { caption: "Resultado listo" }
    );

    assert.deepEqual(result, { mediaId: "media-test-123", mediaType: "document" });
    assert.equal(calls.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("envia lista interactiva para menu de WhatsApp", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  process.env.WHATSAPP_VERIFY_TOKEN = "verify-token-test";
  process.env.WHATSAPP_PHONE_NUMBER_ID = "123456789";
  process.env.WHATSAPP_ACCESS_TOKEN = "whatsapp-token-test";
  process.env.DOCTOR_WHATSAPP_NUMBER = "5210000000000";
  process.env.AI_PROVIDER = "local";

  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    const payload = JSON.parse(options.body);
    assert.equal(payload.type, "interactive");
    assert.equal(payload.interactive.type, "list");
    assert.equal(payload.interactive.action.button, "Opciones");
    assert.equal(payload.interactive.action.sections[0].rows[0].id, "main_schedule");
    assert.equal(payload.interactive.action.sections[0].rows[0].title, "Agendar cita");
    return new Response(JSON.stringify({ messages: [{ id: "wamid.list" }] }), { status: 200 });
  };

  try {
    const { sendWhatsAppList } = await import(`../src/whatsapp.js?list=${Date.now()}`);
    await sendWhatsAppList("5214770000000", {
      body: "Elige una opcion",
      buttonText: "Opciones",
      sections: [{
        title: "Menu del consultorio",
        rows: [{ id: "main_schedule", title: "Agendar cita", description: "Iniciar registro" }]
      }]
    });

    assert.equal(calls.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("envia botones interactivos para confirmaciones de WhatsApp", async () => {
  const originalFetch = globalThis.fetch;
  process.env.WHATSAPP_VERIFY_TOKEN = "verify-token-test";
  process.env.WHATSAPP_PHONE_NUMBER_ID = "123456789";
  process.env.WHATSAPP_ACCESS_TOKEN = "whatsapp-token-test";
  process.env.DOCTOR_WHATSAPP_NUMBER = "5210000000000";
  process.env.AI_PROVIDER = "local";

  globalThis.fetch = async (_url, options) => {
    const payload = JSON.parse(options.body);
    assert.equal(payload.type, "interactive");
    assert.equal(payload.interactive.type, "button");
    assert.equal(payload.interactive.action.buttons[0].reply.id, "appointment_confirm_yes");
    assert.equal(payload.interactive.action.buttons[0].reply.title, "Si, agendar");
    return new Response(JSON.stringify({ messages: [{ id: "wamid.buttons" }] }), { status: 200 });
  };

  try {
    const { sendWhatsAppButtons } = await import(`../src/whatsapp.js?buttons=${Date.now()}`);
    await sendWhatsAppButtons("5214770000000", {
      body: "Confirmas?",
      buttons: [{ id: "appointment_confirm_yes", title: "Si, agendar" }]
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("sendMessageWithOptions usa botones cuando hay hasta tres opciones", async () => {
  const originalFetch = globalThis.fetch;
  process.env.WHATSAPP_VERIFY_TOKEN = "verify-token-test";
  process.env.WHATSAPP_PHONE_NUMBER_ID = "123456789";
  process.env.WHATSAPP_ACCESS_TOKEN = "whatsapp-token-test";
  process.env.DOCTOR_WHATSAPP_NUMBER = "5210000000000";
  process.env.AI_PROVIDER = "local";

  globalThis.fetch = async (_url, options) => {
    const payload = JSON.parse(options.body);
    assert.equal(payload.type, "interactive");
    assert.equal(payload.interactive.type, "button");
    assert.equal(payload.interactive.action.buttons[0].reply.id, "promo_schedule");
    return new Response(JSON.stringify({ messages: [{ id: "wamid.options.buttons" }] }), { status: 200 });
  };

  try {
    const { sendMessageWithOptions } = await import(`../src/whatsapp.js?optionsButtons=${Date.now()}`);
    await sendMessageWithOptions("5214770000000", "Elige", [
      { id: "promo_schedule", title: "Agendar" },
      { id: "promo_includes", title: "Que incluye" },
      { id: "location", title: "Ubicacion" }
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("sendMessageWithOptions usa lista cuando hay cuatro a diez opciones", async () => {
  const originalFetch = globalThis.fetch;
  process.env.WHATSAPP_VERIFY_TOKEN = "verify-token-test";
  process.env.WHATSAPP_PHONE_NUMBER_ID = "123456789";
  process.env.WHATSAPP_ACCESS_TOKEN = "whatsapp-token-test";
  process.env.DOCTOR_WHATSAPP_NUMBER = "5210000000000";
  process.env.AI_PROVIDER = "local";

  globalThis.fetch = async (_url, options) => {
    const payload = JSON.parse(options.body);
    assert.equal(payload.type, "interactive");
    assert.equal(payload.interactive.type, "list");
    assert.equal(payload.interactive.action.sections[0].rows.length, 4);
    return new Response(JSON.stringify({ messages: [{ id: "wamid.options.list" }] }), { status: 200 });
  };

  try {
    const { sendMessageWithOptions } = await import(`../src/whatsapp.js?optionsList=${Date.now()}`);
    await sendMessageWithOptions("5214770000000", "Elige", [
      { id: "slot_1", title: "Opcion 1" },
      { id: "slot_2", title: "Opcion 2" },
      { id: "slot_3", title: "Opcion 3" },
      { id: "slot_4", title: "Opcion 4" }
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("sendMessageWithOptions cae a texto si Meta rechaza el interactivo", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  process.env.WHATSAPP_VERIFY_TOKEN = "verify-token-test";
  process.env.WHATSAPP_PHONE_NUMBER_ID = "123456789";
  process.env.WHATSAPP_ACCESS_TOKEN = "whatsapp-token-test";
  process.env.DOCTOR_WHATSAPP_NUMBER = "5210000000000";
  process.env.AI_PROVIDER = "local";

  globalThis.fetch = async (_url, options) => {
    calls.push(JSON.parse(options.body));
    if (calls.length === 1) {
      return new Response(JSON.stringify({ error: { message: "bad interactive" } }), { status: 400 });
    }
    assert.equal(calls[1].type, "text");
    assert.match(calls[1].text.body, /1\. Agendar/);
    return new Response(JSON.stringify({ messages: [{ id: "wamid.options.text" }] }), { status: 200 });
  };

  try {
    const { sendMessageWithOptions } = await import(`../src/whatsapp.js?optionsFallback=${Date.now()}`);
    await sendMessageWithOptions("5214770000000", "Elige", [
      { id: "promo_schedule", title: "Agendar" },
      { id: "talk_human", title: "Humano" }
    ]);
    assert.equal(calls.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("diagnostica rechazo de Meta por token invalido sin filtrar secretos", async () => {
  const originalFetch = globalThis.fetch;
  process.env.WHATSAPP_VERIFY_TOKEN = "verify-token-test";
  process.env.WHATSAPP_PHONE_NUMBER_ID = "123456789";
  process.env.WHATSAPP_ACCESS_TOKEN = "whatsapp-token-test";
  process.env.DOCTOR_WHATSAPP_NUMBER = "5210000000000";
  process.env.AI_PROVIDER = "local";

  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        error: {
          message: "Error validating access token",
          type: "OAuthException",
          code: 190
        }
      }),
      { status: 401 }
    );

  try {
    const { getLastWhatsAppSendDiagnostic, sendWhatsAppText } = await import(`../src/whatsapp.js?tokenError=${Date.now()}`);
    await assert.rejects(() => sendWhatsAppText("5214770000000", "Hola"), /WhatsApp send/);
    const diagnostic = getLastWhatsAppSendDiagnostic();
    assert.equal(diagnostic.status, 401);
    assert.equal(diagnostic.code, 190);
    assert.equal(diagnostic.category, "token_invalid_or_expired");
    assert.equal(diagnostic.to, "52147****000");
    assert.equal(JSON.stringify(diagnostic).includes("whatsapp-token-test"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
