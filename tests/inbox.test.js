import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";

const {
  buildInboxStats,
  buildLocalConversationSummary,
  filterInboxConversations,
  getConversationActivityISO,
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

test("orden de recepcion pone arriba el ultimo mensaje entrante de paciente", () => {
  const olderPriority = conversation({
    phoneNumber: "5214770000010",
    tags: ["Resultados", "Humano requerido"],
    updatedAt: "2030-06-17T17:58:00.000Z",
    messages: [
      { sender: "patient", body: "quiero resultados", timestamp: "2030-06-17T17:20:00.000Z" },
      { sender: "bot", body: "Lo revisa una persona", timestamp: "2030-06-17T17:21:00.000Z" }
    ]
  });
  const newestPatient = conversation({
    phoneNumber: "5214770000011",
    updatedAt: "2030-06-17T17:59:00.000Z",
    messages: [
      { sender: "patient", body: "Hola, sigo aqui", timestamp: "2030-06-17T17:59:00.000Z" }
    ]
  });
  const olderPatient = conversation({
    phoneNumber: "5214770000012",
    updatedAt: "2030-06-17T17:30:00.000Z",
    messages: [
      { sender: "patient", body: "Hola", timestamp: "2030-06-17T17:30:00.000Z" }
    ]
  });

  const sorted = sortInboxConversations([olderPriority, olderPatient, newestPatient], now, { newestPatientFirst: true });

  assert.deepEqual(sorted.map((item) => item.phoneNumber), [
    "5214770000011",
    "5214770000012",
    "5214770000010"
  ]);
});

test("orden de recepcion usa actividad real de mensajes aunque updated_at este viejo", () => {
  const staleUpdatedAt = conversation({
    phoneNumber: "5214770000020",
    updatedAt: "2030-06-17T16:00:00.000Z",
    messages: [
      { sender: "patient", body: "Acabo de escribir", timestamp: "2030-06-17T17:59:30.000Z" }
    ]
  });
  const newerRowButOlderMessage = conversation({
    phoneNumber: "5214770000021",
    updatedAt: "2030-06-17T17:59:59.000Z",
    messages: [
      { sender: "patient", body: "Hace rato", timestamp: "2030-06-17T17:30:00.000Z" }
    ]
  });

  const sorted = sortInboxConversations([newerRowButOlderMessage, staleUpdatedAt], now, { newestPatientFirst: true });

  assert.equal(getConversationActivityISO(staleUpdatedAt), "2030-06-17T17:59:30.000Z");
  assert.deepEqual(sorted.map((item) => item.phoneNumber), [
    "5214770000020",
    "5214770000021"
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
  assert.equal(filterInboxConversations([conversation({ tags: ["Resultados"], botPaused: true })], "", "results", now).length, 1);
});

test("detecta modo humano, cita agendada y ventana de 24 horas", () => {
  assert.equal(getConversationStatus(conversation({ botPaused: true }), now).key, "human");
  assert.equal(getConversationStatus(conversation({ botPaused: true, tags: ["Resultados"] }), now).key, "results");
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
  assert.equal(
    getWhatsAppWindowState(
      conversation({ messages: [{ sender: "patient", body: "Hola", timestamp: "2030-06-16T17:00:00.000Z" }] }),
      now
    ).label,
    "Fuera de 24h: usa template Meta"
  );
  assert.equal(
    getConversationStatus(
      conversation({ messages: [{ sender: "patient", body: "Hola", timestamp: "2030-06-16T17:00:00.000Z" }] }),
      now
    ).label,
    "Fuera de 24h"
  );
});

test("detecta pasos detallados y pacientes atoradas", () => {
  const waitingEmail = conversation({
    session: { step: "collectingEmail", data: { name: "Ana" } },
    messages: [{ sender: "bot", body: "Me compartes tu correo?", timestamp: "2030-06-17T17:55:00.000Z" }]
  });
  assert.equal(getConversationStatus(waitingEmail, now).key, "waiting_email");
  assert.equal(getConversationStatus(waitingEmail, now).label, "Esperando correo");

  const stuck = conversation({
    session: { step: "collectingService", data: { name: "Ana", email: "ana@example.com" } },
    messages: [{ sender: "bot", body: "Que servicio quieres agendar?", timestamp: "2030-06-17T17:00:00.000Z" }]
  });
  const stuckStatus = getConversationStatus(stuck, now);
  assert.equal(stuckStatus.key, "stuck");
  assert.match(stuckStatus.label, /Paciente atorada/);
  assert.equal(filterInboxConversations([stuck], "", "stuck", now).length, 1);
  assert.equal(filterInboxConversations([waitingEmail], "", "waiting", now).length, 1);
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
