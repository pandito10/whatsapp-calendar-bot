import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";

const {
  buildCrmNextAction,
  buildInboxStats,
  buildLocalConversationSummary,
  buildManualDailyReportEntry,
  buildPatientCrmProfile,
  buildReceptionChecklist,
  buildReceptionQueueSummary,
  filterInboxConversations,
  getConversationActivityISO,
  getConversationStatus,
  getPatientTemperature,
  sanitizeInboxReportText,
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

test("limpia y arma reportes escritos desde el inbox", () => {
  const entry = buildManualDailyReportEntry({
    dateISO: "2030-06-17",
    title: "Pendientes del dia",
    body: "  Llamar a Ana.\r\n\nRevisar pago.\u0000  ",
    author: "recepcion",
    generatedAt: "2030-06-18T01:20:00.000Z"
  });

  assert.equal(entry.date, "2030-06-17");
  assert.equal(entry.source, "manual");
  assert.equal(entry.title, "Pendientes del dia");
  assert.equal(entry.body, "Llamar a Ana.\n\nRevisar pago.");
  assert.match(entry.text, /Reporte manual - Pendientes del dia/);
  assert.match(entry.text, /Llamar a Ana/);
});

test("no permite guardar reporte manual vacio", () => {
  assert.throws(
    () => buildManualDailyReportEntry({ dateISO: "2030-06-17", body: "   \n\t " }),
    /daily_report_body_required/
  );
  assert.equal(sanitizeInboxReportText("  hola\r\nmundo  "), "hola\nmundo");
});

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

test("urgente resuelto baja prioridad sin apagar futuras urgencias", () => {
  const resolved = conversation({
    tags: ["Urgente resuelto"],
    messages: [
      { sender: "patient", body: "tengo sangrado abundante", timestamp: "2030-06-17T17:45:00.000Z" },
      { sender: "admin", body: "Urgencia marcada como resuelta desde el inbox.", timestamp: "2030-06-17T17:50:00.000Z" }
    ]
  });
  assert.notEqual(getConversationStatus(resolved, now).key, "urgent");

  const newUrgent = conversation({
    tags: ["Urgente resuelto", "Urgente"],
    messages: [
      { sender: "patient", body: "tengo dolor intenso", timestamp: "2030-06-17T17:59:00.000Z" }
    ]
  });
  assert.equal(getConversationStatus(newUrgent, now).key, "urgent");
});

test("conversacion resuelta baja prioridad pero revive si paciente vuelve a escribir", () => {
  const resolved = conversation({
    tags: ["Resuelto", "Promo $1200"],
    messages: [
      { sender: "patient", body: "gracias", timestamp: "2030-06-17T17:45:00.000Z" },
      { sender: "admin", body: "Caso marcado como resuelto desde el inbox.", timestamp: "2030-06-17T17:50:00.000Z" }
    ]
  });
  const status = getConversationStatus(resolved, now);
  assert.equal(status.key, "resolved");
  assert.equal(status.priority, 10);
  assert.equal(filterInboxConversations([resolved], "", "resolved", now).length, 1);
  assert.equal(buildCrmNextAction(resolved, now).key, "resolved");

  const revived = conversation({
    tags: ["Resuelto"],
    messages: [
      { sender: "patient", body: "gracias", timestamp: "2030-06-17T17:45:00.000Z" },
      { sender: "admin", body: "Caso marcado como resuelto desde el inbox.", timestamp: "2030-06-17T17:50:00.000Z" },
      { sender: "patient", body: "hola de nuevo", timestamp: "2030-06-17T17:59:00.000Z" }
    ]
  });
  assert.equal(getConversationStatus(revived, now).key, "followup");
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

test("sugiere acciones CRM seguras segun estado de la conversacion", () => {
  const results = conversation({
    tags: ["Resultados", "Humano requerido"],
    messages: [
      { sender: "patient", body: "Quiero mis resultados", timestamp: "2030-06-17T17:45:00.000Z" }
    ]
  });
  const resultAction = buildCrmNextAction(results, now);
  assert.equal(resultAction.key, "results_email");
  assert.match(resultAction.detail, /correo/i);

  const expired = conversation({
    messages: [{ sender: "patient", body: "Hola", timestamp: "2030-06-16T17:00:00.000Z" }]
  });
  assert.equal(buildCrmNextAction(expired, now).key, "template");

  const stuck = conversation({
    session: { step: "collectingEmail", data: { name: "Ana" } },
    messages: [{ sender: "bot", body: "Me compartes tu correo?", timestamp: "2030-06-17T17:00:00.000Z" }]
  });
  assert.equal(buildCrmNextAction(stuck, now).key, "waiting");
});

test("calcula temperatura del paciente para priorizar CRM", () => {
  assert.equal(
    getPatientTemperature(
      conversation({ messages: [{ sender: "patient", body: "Sigo aqui", timestamp: "2030-06-17T17:59:00.000Z" }] }),
      now
    ).key,
    "hot"
  );

  assert.equal(
    getPatientTemperature(
      conversation({
        messages: [{ sender: "bot", body: "Cita registrada", timestamp: "2030-06-17T17:00:00.000Z" }],
        appointment: { status: "confirmed", patientName: "Ana", slotStart: "2030-06-18T22:40:00.000Z" }
      }),
      now
    ).key,
    "cold"
  );

  assert.equal(
    getPatientTemperature(conversation({ messages: [{ sender: "bot", body: "Te paso info", timestamp: "2030-06-17T17:20:00.000Z" }] }), now).key,
    "warm"
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
  assert.equal(buildInboxStats([conversation({
    tags: ["Resuelto"],
    messages: [
      { sender: "patient", body: "gracias", timestamp: "2030-06-17T17:30:00.000Z" },
      { sender: "admin", body: "Caso marcado como resuelto desde el inbox.", timestamp: "2030-06-17T17:40:00.000Z" }
    ]
  })], now).resolved, 1);
});

test("construye checklist de recepcion con datos faltantes", () => {
  const checklist = buildReceptionChecklist(conversation({
    session: { step: "collectingEmail", data: { name: "Ana Lopez", reason: "Promo" } },
    messages: [
      { sender: "patient", body: "Quiero la promo el viernes", timestamp: "2030-06-17T17:40:00.000Z" }
    ]
  }), now);

  assert.equal(checklist.items.find((item) => item.key === "name").done, true);
  assert.equal(checklist.items.find((item) => item.key === "email").done, false);
  assert.equal(checklist.items.find((item) => item.key === "service").done, true);
  assert.equal(checklist.items.find((item) => item.key === "reply").done, false);
  assert.equal(checklist.nextMissing.key, "email");
});

test("checklist de recepcion queda completo con cita confirmada y correo", () => {
  const checklist = buildReceptionChecklist(conversation({
    appointment: {
      status: "confirmed",
      patientName: "Ana Lopez",
      patientEmail: "ana@example.com",
      slotStart: "2030-06-20T22:40:00.000Z",
      reason: "Promo"
    },
    messages: [
      { sender: "patient", body: "Gracias", timestamp: "2030-06-17T17:40:00.000Z" },
      { sender: "bot", body: "Tu cita quedo confirmada", timestamp: "2030-06-17T17:41:00.000Z" }
    ]
  }), now);

  assert.equal(checklist.completeCount, checklist.total);
  assert.equal(checklist.nextMissing, undefined);
});

test("resumen de recepcion cuenta pendientes operativos", () => {
  const summary = buildReceptionQueueSummary([
    conversation({
      phoneNumber: "5214770000101",
      messages: [{ sender: "patient", body: "Hola, quiero cita", timestamp: "2030-06-17T17:59:00.000Z" }]
    }),
    conversation({
      phoneNumber: "5214770000102",
      tags: ["Resultados"],
      messages: [{ sender: "patient", body: "Quiero mis resultados", timestamp: "2030-06-17T17:50:00.000Z" }]
    }),
    conversation({
      phoneNumber: "5214770000103",
      session: { step: "confirmingAppointment", data: { name: "Sofia", email: "sofia@example.com", reason: "Consulta" } },
      messages: [{ sender: "bot", body: "Confirmas?", timestamp: "2030-06-17T17:45:00.000Z" }]
    }),
    conversation({
      phoneNumber: "5214770000104",
      tags: ["Resuelto"],
      messages: [
        { sender: "patient", body: "gracias", timestamp: "2030-06-17T17:30:00.000Z" },
        { sender: "admin", body: "Caso marcado como resuelto desde el inbox.", timestamp: "2030-06-17T17:40:00.000Z" }
      ]
    })
  ], now);

  assert.equal(summary.needsReply, 2);
  assert.equal(summary.resultsPending, 1);
  assert.equal(summary.readyToConfirm, 1);
  assert.equal(summary.resolved, 1);
  assert.ok(summary.nextTasks.length > 0);
});

test("construye perfil CRM de paciente con historial de citas", () => {
  const profile = buildPatientCrmProfile(
    conversation({
      appointment: {
        status: "confirmed",
        patientName: "Ana Lopez",
        patientEmail: "ana@example.com",
        slotStart: "2030-06-20T22:40:00.000Z",
        reason: "Promo",
        paymentType: "Particular",
        createdAt: "2030-06-10T18:00:00.000Z"
      },
      appointments: [
        {
          status: "confirmed",
          patientName: "Ana Lopez",
          patientEmail: "ana@example.com",
          slotStart: "2030-06-10T22:40:00.000Z",
          reason: "Consulta",
          paymentType: "Particular",
          createdAt: "2030-06-01T18:00:00.000Z"
        },
        {
          status: "cancelled",
          patientName: "Ana Lopez",
          slotStart: "2030-06-12T22:40:00.000Z",
          createdAt: "2030-06-02T18:00:00.000Z"
        },
        {
          status: "confirmed",
          patientName: "Ana Lopez",
          patientEmail: "ana@example.com",
          slotStart: "2030-06-20T22:40:00.000Z",
          reason: "Promo",
          paymentType: "Particular",
          createdAt: "2030-06-10T18:00:00.000Z"
        }
      ],
      notes: [
        { body: "Pidio resultados", createdAt: "2030-06-12T18:00:00.000Z" }
      ]
    }),
    now
  );

  assert.equal(profile.name, "Ana Lopez");
  assert.equal(profile.appointmentCount, 2);
  assert.equal(profile.cancelledCount, 1);
  assert.equal(profile.notesCount, 1);
  assert.equal(profile.patientStage, "Con proxima cita");
  assert.equal(profile.nextAppointment.slotStart, "2030-06-20T22:40:00.000Z");
  assert.equal(profile.lastAppointment.slotStart, "2030-06-10T22:40:00.000Z");
  assert.equal(profile.latestReason, "Promo");
});

test("usa ficha CRM persistente cuando no hay historial completo cargado", () => {
  const profile = buildPatientCrmProfile(
    conversation({
      patient: {
        name: "Marisol Rocha",
        email: "marisol@example.com",
        firstSeenAt: "2030-06-01T17:00:00.000Z",
        appointmentCount: 3,
        cancelledCount: 1,
        notesCount: 4,
        nextAppointmentAt: "2030-06-20T22:40:00.000Z",
        lastAppointmentAt: "2030-06-10T22:40:00.000Z",
        lastService: "Promocion",
        lastPaymentType: "Particular",
        tags: ["Promo $1200"]
      },
      appointment: undefined,
      appointments: [],
      notes: []
    }),
    now
  );

  assert.equal(profile.name, "Marisol Rocha");
  assert.equal(profile.email, "marisol@example.com");
  assert.equal(profile.appointmentCount, 3);
  assert.equal(profile.cancelledCount, 1);
  assert.equal(profile.notesCount, 4);
  assert.equal(profile.patientStage, "Con proxima cita");
  assert.equal(profile.nextAppointment.slotStart, "2030-06-20T22:40:00.000Z");
  assert.equal(profile.latestReason, "Promocion");
});
