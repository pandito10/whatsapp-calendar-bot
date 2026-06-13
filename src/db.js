import { config } from "./config.js";
import { resilientFetch, readResponseTextSafe, buildHttpError } from "./http.js";

const maxConversations = 50;
const maxMessagesPerConversation = 100;

export function isDatabaseEnabled() {
  return Boolean(config.supabaseUrl && config.supabaseServiceRoleKey);
}

export async function saveConversationMessage(phoneNumber, sender, body, metadata = {}) {
  if (!isDatabaseEnabled()) return;

  const timestamp = new Date().toISOString();
  await safeSupabaseFetch("/rest/v1/conversations?on_conflict=phone_number", {
    method: "POST",
    headers: {
      Prefer: "resolution=merge-duplicates"
    },
    body: JSON.stringify({
      phone_number: phoneNumber,
      updated_at: timestamp
    })
  });

  const messagePayload = {
    phone_number: phoneNumber,
    sender,
    body,
    metadata,
    created_at: timestamp
  };

  try {
    await supabaseFetch("/rest/v1/messages", {
      method: "POST",
      body: JSON.stringify(messagePayload)
    });
  } catch (error) {
    if (error.message?.includes("metadata")) {
      const { metadata: _metadata, ...legacyPayload } = messagePayload;
      await supabaseFetch("/rest/v1/messages", {
        method: "POST",
        body: JSON.stringify(legacyPayload)
      });
      return;
    }
    throw error;
  }
}

export async function loadConversations() {
  if (!isDatabaseEnabled()) return undefined;

  const conversations =
    (await safeSupabaseFetch(
      `/rest/v1/conversations?select=phone_number,updated_at,assigned_to,bot_paused,bot_paused_at,last_human_reply_at&order=updated_at.desc&limit=${maxConversations}`
    )) ??
    (await supabaseFetch(
      `/rest/v1/conversations?select=phone_number,updated_at&order=updated_at.desc&limit=${maxConversations}`
    ));
  if (conversations.length === 0) return [];

  const phoneNumbers = conversations.map((conversation) => conversation.phone_number);
  const messages =
    (await safeSupabaseFetch(
      `/rest/v1/messages?select=phone_number,sender,body,metadata,created_at&phone_number=in.(${phoneNumbers
        .map(encodeURIComponent)
        .join(",")})&order=created_at.asc`
    )) ??
    (await supabaseFetch(
      `/rest/v1/messages?select=phone_number,sender,body,created_at&phone_number=in.(${phoneNumbers
        .map(encodeURIComponent)
        .join(",")})&order=created_at.asc`
    ));
  const citas =
    (await safeSupabaseFetch(
      `/rest/v1/citas?select=phone_number,patient_name,patient_email,slot_start,slot_end,status,first_visit,payment_type,reason,created_at&phone_number=in.(${phoneNumbers
        .map(encodeURIComponent)
        .join(",")})&order=created_at.desc`
    )) ?? [];
  const byPhone = new Map();
  for (const conversation of conversations) {
    byPhone.set(conversation.phone_number, {
      phoneNumber: conversation.phone_number,
      updatedAt: conversation.updated_at,
      assignedTo: conversation.assigned_to,
      botPaused: Boolean(conversation.bot_paused),
      botPausedAt: conversation.bot_paused_at,
      lastHumanReplyAt: conversation.last_human_reply_at,
      messages: [],
      appointment: undefined
    });
  }

  for (const message of messages) {
    const conversation = byPhone.get(message.phone_number);
    if (!conversation) continue;
    conversation.messages.push({
      sender: message.sender,
      body: message.body,
      metadata: message.metadata ?? {},
      timestamp: message.created_at
    });
    conversation.messages = conversation.messages.slice(-maxMessagesPerConversation);
  }

  for (const cita of citas) {
    const conversation = byPhone.get(cita.phone_number);
    if (!conversation || conversation.appointment) continue;
    conversation.appointment = {
      patientName: cita.patient_name,
      patientEmail: cita.patient_email,
      slotStart: cita.slot_start,
      slotEnd: cita.slot_end,
      status: cita.status,
      firstVisit: cita.first_visit,
      paymentType: cita.payment_type,
      reason: cita.reason,
      createdAt: cita.created_at
    };
  }

  return [...byPhone.values()];
}

export async function getConversationState(phoneNumber) {
  if (!isDatabaseEnabled()) return null;

  const rows = await safeSupabaseFetch(
    `/rest/v1/conversations?select=phone_number,assigned_to,bot_paused,bot_paused_at,last_human_reply_at&phone_number=eq.${encodeURIComponent(
      phoneNumber
    )}&limit=1`
  );
  const row = rows?.[0];
  if (!row) return null;
  return {
    phoneNumber: row.phone_number,
    assignedTo: row.assigned_to,
    botPaused: Boolean(row.bot_paused),
    botPausedAt: row.bot_paused_at,
    lastHumanReplyAt: row.last_human_reply_at
  };
}

export async function setConversationHumanMode(phoneNumber, enabled, assignedTo = "consultorio") {
  if (!isDatabaseEnabled()) return;

  await safeSupabaseFetch("/rest/v1/conversations?on_conflict=phone_number", {
    method: "POST",
    headers: {
      Prefer: "resolution=merge-duplicates"
    },
    body: JSON.stringify({
      phone_number: phoneNumber,
      assigned_to: enabled ? assignedTo : null,
      bot_paused: enabled,
      bot_paused_at: enabled ? new Date().toISOString() : null,
      updated_at: new Date().toISOString()
    })
  });
}

export async function markConversationHumanReply(phoneNumber) {
  if (!isDatabaseEnabled()) return;

  await supabaseFetch("/rest/v1/conversations?on_conflict=phone_number", {
    method: "POST",
    headers: {
      Prefer: "resolution=merge-duplicates"
    },
    body: JSON.stringify({
      phone_number: phoneNumber,
      last_human_reply_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })
  });
}

export async function saveKnowledgeSuggestion({ question, answer, sourcePhone }) {
  if (!isDatabaseEnabled() || !answer) return;

  await safeSupabaseFetch("/rest/v1/knowledge_suggestions", {
    method: "POST",
    body: JSON.stringify({
      question,
      answer,
      source_phone: sourcePhone,
      status: "pending"
    })
  });
}

export async function loadKnowledgeSuggestions(status = "pending", limit = 20) {
  if (!isDatabaseEnabled()) return [];

  const rows =
    (await safeSupabaseFetch(
      `/rest/v1/knowledge_suggestions?select=id,question,answer,source_phone,status,created_at&status=eq.${encodeURIComponent(
        status
      )}&order=created_at.desc&limit=${limit}`
    )) ?? [];

  return rows.map((row) => ({
    id: row.id,
    question: row.question,
    answer: row.answer,
    sourcePhone: row.source_phone,
    status: row.status,
    createdAt: row.created_at
  }));
}

export async function reviewKnowledgeSuggestion(id, status) {
  if (!isDatabaseEnabled() || !id || !["approved", "rejected"].includes(status)) return;

  await supabaseFetch(`/rest/v1/knowledge_suggestions?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({
      status,
      reviewed_at: new Date().toISOString()
    })
  });
}

export async function rememberProcessedWhatsAppMessage(messageId, fromPhone) {
  if (!isDatabaseEnabled() || !messageId) return false;

  try {
    await supabaseFetch("/rest/v1/processed_whatsapp_messages", {
      method: "POST",
      body: JSON.stringify({
        message_id: messageId,
        from_phone: fromPhone
      })
    });
    return false;
  } catch (error) {
    if (error.message?.includes("409") || error.message?.includes("duplicate key")) return true;
    throw error;
  }
}

export async function cleanupProcessedWhatsAppMessages(days = 30) {
  if (!isDatabaseEnabled()) return;
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  await safeSupabaseFetch(`/rest/v1/processed_whatsapp_messages?created_at=lt.${encodeURIComponent(cutoff)}`, {
    method: "DELETE"
  });
}

export async function getSession(phoneNumber) {
  if (!isDatabaseEnabled()) return null;

  const rows = await supabaseFetch(
    `/rest/v1/sessions?select=phone_number,step,data,updated_at&phone_number=eq.${encodeURIComponent(phoneNumber)}&limit=1`
  );
  const row = rows?.[0];
  if (!row) return null;

  return {
    from: row.phone_number,
    step: row.step,
    ...(row.data ?? {}),
    updatedAt: row.updated_at
  };
}

export async function setSession(phoneNumber, sessionData) {
  if (!isDatabaseEnabled()) return;

  const { from, step = "collecting", updatedAt, ...data } = sessionData;
  await supabaseFetch("/rest/v1/sessions?on_conflict=phone_number", {
    method: "POST",
    headers: {
      Prefer: "resolution=merge-duplicates"
    },
    body: JSON.stringify({
      phone_number: phoneNumber,
      step,
      data,
      updated_at: new Date().toISOString()
    })
  });
}

export async function deleteSession(phoneNumber) {
  if (!isDatabaseEnabled()) return;

  await supabaseFetch(`/rest/v1/sessions?phone_number=eq.${encodeURIComponent(phoneNumber)}`, {
    method: "DELETE"
  });
}


export async function acquireAppointmentLock({ slotStart, slotEnd, phoneNumber }) {
  if (!isDatabaseEnabled()) return null;

  const now = new Date();
  const expiresAt = new Date(now.getTime() + Math.max(1, config.appointmentLockMinutes) * 60_000).toISOString();
  const token = cryptoRandomToken();

  await safeSupabaseFetch(`/rest/v1/appointment_locks?expires_at=lt.${encodeURIComponent(now.toISOString())}`, {
    method: "DELETE"
  });

  try {
    const rows = await supabaseFetch("/rest/v1/appointment_locks?select=id,lock_token,slot_start,slot_end,expires_at", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        slot_start: slotStart,
        slot_end: slotEnd,
        lock_token: token,
        phone_number: phoneNumber,
        expires_at: expiresAt
      })
    });

    const row = rows?.[0];
    if (!row) return null;
    return {
      id: row.id,
      token: row.lock_token,
      slotStart: row.slot_start,
      slotEnd: row.slot_end,
      expiresAt: row.expires_at
    };
  } catch (error) {
    if (error.message?.includes("409") || error.message?.includes("duplicate key")) return null;
    throw error;
  }
}

export async function releaseAppointmentLock(lockToken) {
  if (!isDatabaseEnabled() || !lockToken) return;
  await safeSupabaseFetch(`/rest/v1/appointment_locks?lock_token=eq.${encodeURIComponent(lockToken)}`, {
    method: "DELETE"
  });
}

export async function markCitaFailedByGoogleEvent(googleEventId, errorMessage) {
  if (!isDatabaseEnabled() || !googleEventId) return;
  await safeSupabaseFetch(`/rest/v1/citas?google_event_id=eq.${encodeURIComponent(googleEventId)}`, {
    method: "PATCH",
    body: JSON.stringify({
      status: "failed",
      error_message: String(errorMessage ?? "").slice(0, 500)
    })
  });
}

export async function saveCita(citaData) {
  if (!isDatabaseEnabled()) return null;

  const rows = await supabaseFetch("/rest/v1/citas?select=id,phone_number,slot_start,slot_end,status", {
    method: "POST",
    headers: {
      Prefer: "return=representation"
    },
    body: JSON.stringify({
      phone_number: citaData.phoneNumber,
      patient_name: citaData.patientName,
      patient_email: citaData.patientEmail,
      google_event_id: citaData.googleEventId,
      slot_start: citaData.slotStart,
      slot_end: citaData.slotEnd,
      status: citaData.status ?? "confirmed",
      first_visit: citaData.firstVisit,
      payment_type: citaData.paymentType,
      reason: citaData.reason,
      error_message: citaData.errorMessage
    })
  });

  const row = rows?.[0];
  if (!row) return null;
  return {
    id: row.id,
    phoneNumber: row.phone_number,
    slotStart: row.slot_start,
    slotEnd: row.slot_end,
    status: row.status
  };
}

export async function getLatestConfirmedCitaByPhone(phoneNumber) {
  if (!isDatabaseEnabled()) return null;

  const rows = await supabaseFetch(
    `/rest/v1/citas?select=id,phone_number,patient_name,patient_email,google_event_id,slot_start,slot_end,status&phone_number=eq.${encodeURIComponent(
      phoneNumber
    )}&status=eq.confirmed&order=slot_start.desc&limit=1`
  );
  const row = rows?.[0];
  if (!row) return null;

  return {
    id: row.id,
    phoneNumber: row.phone_number,
    patientName: row.patient_name,
    patientEmail: row.patient_email,
    googleEventId: row.google_event_id,
    slotStart: row.slot_start,
    slotEnd: row.slot_end,
    status: row.status
  };
}

export async function cancelCita(citaId) {
  if (!isDatabaseEnabled() || !citaId) return;

  await supabaseFetch(`/rest/v1/citas?id=eq.${encodeURIComponent(citaId)}`, {
    method: "PATCH",
    body: JSON.stringify({ status: "cancelled" })
  });

  await supabaseFetch(`/rest/v1/appointment_reminders?cita_id=eq.${encodeURIComponent(citaId)}`, {
    method: "PATCH",
    body: JSON.stringify({ status: "cancelled" })
  });
}

export async function scheduleReminder(reminderData) {
  if (!isDatabaseEnabled()) return;

  await supabaseFetch("/rest/v1/appointment_reminders?on_conflict=cita_id,reminder_type", {
    method: "POST",
    headers: {
      Prefer: "resolution=merge-duplicates"
    },
    body: JSON.stringify({
      cita_id: reminderData.citaId,
      phone_number: reminderData.phoneNumber,
      reminder_type: reminderData.reminderType ?? "admin_24h",
      remind_at: reminderData.remindAt,
      status: "pending",
      payload: reminderData.payload ?? {}
    })
  });
}

export async function loadDueReminders(limit = 10) {
  if (!isDatabaseEnabled()) return [];

  return (
    (await safeSupabaseFetch(
      `/rest/v1/appointment_reminders?select=id,cita_id,phone_number,reminder_type,remind_at,payload,status&status=eq.pending&remind_at=lte.${encodeURIComponent(
        new Date().toISOString()
      )}&order=remind_at.asc&limit=${limit}`
    )) ?? []
  ).map((row) => ({
    id: row.id,
    citaId: row.cita_id,
    phoneNumber: row.phone_number,
    reminderType: row.reminder_type,
    remindAt: row.remind_at,
    payload: row.payload ?? {},
    status: row.status
  }));
}

export async function markReminderSent(reminderId) {
  if (!isDatabaseEnabled() || !reminderId) return;

  await supabaseFetch(`/rest/v1/appointment_reminders?id=eq.${encodeURIComponent(reminderId)}`, {
    method: "PATCH",
    body: JSON.stringify({
      status: "sent",
      sent_at: new Date().toISOString()
    })
  });
}

export async function markReminderFailed(reminderId, errorMessage) {
  if (!isDatabaseEnabled() || !reminderId) return;

  await supabaseFetch(`/rest/v1/appointment_reminders?id=eq.${encodeURIComponent(reminderId)}`, {
    method: "PATCH",
    body: JSON.stringify({
      status: "failed",
      error_message: String(errorMessage ?? "").slice(0, 500)
    })
  });
}

export async function checkDatabaseHealth() {
  if (!isDatabaseEnabled()) return { ok: false, status: "disabled" };
  try {
    await supabaseFetch("/rest/v1/conversations?select=phone_number&limit=1");
    return { ok: true, status: "ok" };
  } catch (error) {
    return { ok: false, status: "error", message: error?.message };
  }
}

async function safeSupabaseFetch(path, options = {}) {
  try {
    return await supabaseFetch(path, options);
  } catch (error) {
    console.warn("Supabase optional request failed:", error.message);
    return undefined;
  }
}

async function supabaseFetch(path, options = {}) {
  const method = String(options.method ?? "GET").toUpperCase();
  const response = await resilientFetch(`${config.supabaseUrl.replace(/\/$/, "")}${path}`, {
    ...options,
    headers: {
      apikey: config.supabaseServiceRoleKey,
      Authorization: `Bearer ${config.supabaseServiceRoleKey}`,
      "Content-Type": "application/json",
      ...(options.headers ?? {})
    }
  }, {
    label: "Supabase",
    timeoutMs: config.externalRequestTimeoutMs,
    retries: method === "GET" ? config.externalRequestRetries : 0
  });

  if (!response.ok) {
    throw buildHttpError("Supabase request", response, await readResponseTextSafe(response));
  }

  if (response.status === 204) return undefined;
  const text = await response.text();
  return text ? JSON.parse(text) : undefined;
}

function cryptoRandomToken() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
