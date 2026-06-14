import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";

const {
  buildInboxStats,
  buildLocalConversationSummary,
  filterInboxConversations,
  getConversationStatus,
  getWhatsAppWindowState,
  sortInboxConversations
} = await import("../src/inbox.js");

const now = new Date("2030-06-17T18:00:00.000Z").getTime();

function conversation(overrides = {}) {
  return {
    phoneNumber: "5214771234567",
    updatedAt: "2030-06-17T17:50:00.000Z",
    tags: [],
    botPaused: false,
    messages: [
      { sender: "patient", body: "Hola", timestamp: "2030-06-17T17:40:00.000Z" }
    ],
    ...overrides
  };
}

test("prioriza conversaciones urgentes, no entendidas y por confirmar", () => {
  const confirmed = conversation({
    phoneNumber: "5214770000001",
    messages: [{ sender: "bot", body: "Cita lista", timestamp: "2030-06-17T17:00:00.000Z" }],
    appointment: { status: "confirmed", patientName: "Ana", slotStart: "2030-06-18T22:40:00.000Z" }
  });
  const confirming = conversation({
    phoneNumber: "5214770000002",
    session: { step: "confirmingAppointment", data: {} }
  });
  const misunderstood = conversation({
    phoneNumber: "5214770000003",
    messages: [
      { sender: "patient", body: "eso que", timestamp: "2030-06-17T17:30:00.000Z" },
      { sender: "bot", body: "Perdon, no entendi bien", timestamp: "2030-06-17T17:31:00.000Z" }
    ]
  });
  const urgent = conversation({
    phoneNumber: "5214770000004",
    tags: ["Urgente"],
    messages: [{ sender: "patient", body: "tengo sangrado abundante", timestamp: "2030-06-17T17:45:00.000Z" }]
  });

  const sorted = sortInboxConversations([confirmed, confirming, misunderstood, urgent], now);
  assert.deepEqual(sorted.map((item) => item.phoneNumber), [
    "5214770000004",
    "5214770000003",
    "5214770000002",
    "5214770000001"
  ]);
});

test("filtra por estado, etiqueta, nombre y telefono", () => {
  const list = [
    conversation({ phoneNumber: "5214771111111", tags: ["Urgente"] }),
    conversation({
      phoneNumber: "5214772222222",
      appointment: { status: "confirmed", patientName: "Laura Perez", slotStart: "2030-06-18T22:40:00.000Z" },
      messages: [{ sender: "bot", body: "Cita registrada", timestamp: "2030-06-17T17:00:00.000Z" }]
    })
  ];

  assert.equal(filterInboxConversations(list, "", "urgent", now).length, 1);
  assert.equal(filterInboxConversations(list, "Laura", "all", now).length, 1);
  assert.equal(filterInboxConversations(list, "2222", "all", now).length, 1);
  assert.equal(filterInboxConversations(list, "Urgente", "all", now).length, 1);
  assert.equal(filterInboxConversations(list, "", "followup", now).length, 1);
});

test("detecta modo humano, cita agendada y ventana de 24 horas", () => {
  assert.equal(getConversationStatus(conversation({ botPaused: true }), now).key, "human");
  assert.equal(
    getConversationStatus(
      conversation({
        messages: [{ sender: "bot", body: "Cita registrada", timestamp: "2030-06-17T17:00:00.000Z" }],
        appointment: { status: "confirmed", patientName: "Ana", slotStart: "2030-06-18T22:40:00.000Z" }
      }),
      now
    ).key,
    "confirmed"
  );
  assert.equal(
    getWhatsAppWindowState(
      conversation({ messages: [{ sender: "patient", body: "Hola", timestamp: "2030-06-16T19:00:00.000Z" }] }),
      now
    ).key,
    "closing"
  );
  assert.equal(
    getWhatsAppWindowState(
      conversation({ messages: [{ sender: "patient", body: "Hola", timestamp: "2030-06-16T17:00:00.000Z" }] }),
      now
    ).key,
    "expired"
  );
});

test("construye resumen local sin IA", () => {
  const summary = buildLocalConversationSummary(
    conversation({
      appointment: { status: "confirmed", patientName: "Sofia", slotStart: "2030-06-18T22:40:00.000Z" },
      messages: [{ sender: "patient", body: "quiero cita el 25 de octubre", timestamp: "2030-06-17T17:40:00.000Z" }]
    }),
    now
  );

  assert.equal(summary.name, "Sofia");
  assert.equal(summary.dateMention, "25 de octubre");
  assert.equal(summary.appointmentStatus, "confirmed");
});

test("calcula metricas del inbox", () => {
  const stats = buildInboxStats([
    conversation({ tags: ["Urgente"] }),
    conversation({ botPaused: true }),
    conversation({
      messages: [{ sender: "bot", body: "Cita registrada", timestamp: "2030-06-17T17:00:00.000Z" }],
      appointment: { status: "confirmed", patientName: "Ana", slotStart: "2030-06-18T22:40:00.000Z" }
    })
  ], now);

  assert.equal(stats.total, 3);
  assert.equal(stats.urgent, 1);
  assert.equal(stats.human, 1);
  assert.equal(stats.confirmed, 1);
  assert.equal(stats.noReply, 2);
});
