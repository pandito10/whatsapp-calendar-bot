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
      `/rest/v1/conversations?select=phone_number,updated_at,assigned_to,bot_paused,bot_paused_at,last_human_reply_at,tags&order=updated_at.desc&limit=${maxConversations}`
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
      `/rest/v1/citas?select=phone_number,patient_name,patient_email,google_event_id,slot_start,slot_end,status,first_visit,payment_type,reason,created_at&phone_number=in.(${phoneNumbers
        .map(encodeURIComponent)
        .join(",")})&order=created_at.desc`
    )) ?? [];
  const sessions =
    (await safeSupabaseFetch(
      `/rest/v1/sessions?select=phone_number,step,data,updated_at&phone_number=in.(${phoneNumbers
        .map(encodeURIComponent)
        .join(",")})`
    )) ?? [];
  const notes =
    (await safeSupabaseFetch(
      `/rest/v1/conversation_notes?select=id,phone_number,body,author,created_at&phone_number=in.(${phoneNumbers
        .map(encodeURIComponent)
        .join(",")})&order=created_at.desc&limit=100`
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
      tags: Array.isArray(conversation.tags) ? conversation.tags : [],
      messages: [],
      notes: [],
      session: undefined,
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
      googleEventId: cita.google_event_id,
      slotStart: cita.slot_start,
      slotEnd: cita.slot_end,
      status: cita.status,
      firstVisit: cita.first_visit,
      paymentType: cita.payment_type,
      reason: cita.reason,
      createdAt: cita.created_at
    };
  }

  for (const session of sessions) {
    const conversation = byPhone.get(session.phone_number);
    if (!conversation) continue;
    conversation.session = {
      step: session.step,
      data: session.data ?? {},
      updatedAt: session.updated_at
    };
  }

  for (const note of notes) {
    const conversation = byPhone.get(note.phone_number);
    if (!conversation) continue;
    conversation.notes.push({
      id: note.id,
      body: note.body,
      author: note.author,
      createdAt: note.created_at
    });
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

export async function setConversationTags(phoneNumber, tags = []) {
  if (!isDatabaseEnabled() || !phoneNumber) return;

  await safeSupabaseFetch("/rest/v1/conversations?on_conflict=phone_number", {
    method: "POST",
    headers: {
      Prefer: "resolution=merge-duplicates"
    },
    body: JSON.stringify({
      phone_number: phoneNumber,
      tags: [...new Set(tags)].slice(0, 12),
      updated_at: new Date().toISOString()
    })
  });
}

export async function saveConversationNote({ phoneNumber, body, author = "consultorio" }) {
  if (!isDatabaseEnabled() || !phoneNumber || !body) return;

  await supabaseFetch("/rest/v1/conversation_notes", {
    method: "POST",
    body: JSON.stringify({
      phone_number: phoneNumber,
      body: String(body).slice(0, 2000),
      author: String(author).slice(0, 120)
    })
  });
}

export async function saveKnowledgeSuggestion({ question, answer, sourcePhone, status = "pending", category, conversationPhone, action = "answer", active = true, intent, variations = [], priority = 100 }) {
  if (!isDatabaseEnabled() || !question) return;

  await safeSupabaseFetch("/rest/v1/knowledge_suggestions", {
    method: "POST",
    body: JSON.stringify({
      question,
      answer: answer || null,
      source_phone: sourcePhone,
      conversation_phone: conversationPhone ?? sourcePhone,
      category,
      intent,
      variations,
      priority,
      action: ["answer", "human_handoff"].includes(action) ? action : "answer",
      active,
      status: ["pending", "approved", "rejected", "ignored"].includes(status) ? status : "pending",
      reviewed_at: ["approved", "rejected", "ignored"].includes(status) ? new Date().toISOString() : undefined
    })
  });
}

export async function loadKnowledgeSuggestions(status = "pending", limit = 20) {
  if (!isDatabaseEnabled()) return [];

  const rows =
    (await safeSupabaseFetch(
      `/rest/v1/knowledge_suggestions?select=id,question,answer,source_phone,conversation_phone,category,intent,variations,priority,action,active,status,created_at&status=eq.${encodeURIComponent(
        status
      )}&order=created_at.desc&limit=${limit}`
    )) ??
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
    conversationPhone: row.conversation_phone,
    category: row.category,
    intent: row.intent,
    variations: Array.isArray(row.variations) ? row.variations : [],
    priority: row.priority ?? 100,
    action: row.action ?? "answer",
    active: row.active !== false,
    status: row.status,
    createdAt: row.created_at
  }));
}

export async function reviewKnowledgeSuggestion(id, status, updates = {}) {
  if (!isDatabaseEnabled() || !id || !["approved", "rejected", "ignored"].includes(status)) return;

  await supabaseFetch(`/rest/v1/knowledge_suggestions?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({
      status,
      answer: updates.answer !== undefined ? updates.answer : undefined,
      category: updates.category !== undefined ? updates.category : undefined,
      intent: updates.intent !== undefined ? updates.intent : undefined,
      variations: updates.variations !== undefined ? updates.variations : undefined,
      priority: updates.priority !== undefined ? updates.priority : undefined,
      action: updates.action !== undefined ? updates.action : undefined,
      active: updates.active !== undefined ? updates.active : undefined,
      reviewed_at: new Date().toISOString()
    })
  });
}

export async function updateKnowledgeSuggestion(id, updates = {}) {
  if (!isDatabaseEnabled() || !id) return;

  await supabaseFetch(`/rest/v1/knowledge_suggestions?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({
      question: updates.question,
      answer: updates.answer,
      category: updates.category,
      intent: updates.intent,
      variations: updates.variations,
      priority: updates.priority,
      action: updates.action,
      active: updates.active,
      reviewed_at: updates.status ? new Date().toISOString() : undefined
    })
  });
}

export async function deleteKnowledgeSuggestion(id) {
  if (!isDatabaseEnabled() || !id) return;

  await supabaseFetch(`/rest/v1/knowledge_suggestions?id=eq.${encodeURIComponent(id)}`, {
    method: "DELETE"
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
  const payload = {
    slot_start: slotStart,
    slot_end: slotEnd,
    lock_token: token,
    phone_number: phoneNumber,
    expires_at: expiresAt
  };

  await cleanupExpiredAppointmentLocks(now);

  try {
    return await insertAppointmentLock(payload);
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      const existing = await getAppointmentLockForSlot(slotStart, slotEnd);
      if (!existing) return null;

      if (isExpiredLock(existing, now)) {
        console.warn(
          `Expired appointment lock blocked slot; deleting before retry. slot_start=${existing.slotStart} slot_end=${existing.slotEnd} expires_at=${existing.expiresAt}`
        );
        try {
          await deleteAppointmentLockById(existing.id);
        } catch (deleteError) {
          console.warn(
            `Could not delete expired appointment lock. slot_start=${existing.slotStart} slot_end=${existing.slotEnd} expires_at=${existing.expiresAt}: ${deleteError.message}`
          );
          throw new Error("Expired appointment lock could not be deleted", { cause: deleteError });
        }
        return await insertAppointmentLock(payload);
      }

      console.warn(
        `Active appointment lock blocked slot. slot_start=${existing.slotStart} slot_end=${existing.slotEnd} expires_at=${existing.expiresAt}`
      );
      return null;
    }
    throw error;
  }
}

export async function cleanupExpiredAppointmentLocks(now = new Date()) {
  if (!isDatabaseEnabled()) return { ok: false, status: "disabled" };
  const cutoff = now.toISOString();
  try {
    await supabaseFetch(`/rest/v1/appointment_locks?expires_at=lt.${encodeURIComponent(cutoff)}`, {
      method: "DELETE"
    });
    return { ok: true };
  } catch (error) {
    console.warn(`Could not cleanup expired appointment locks before locking. cutoff=${cutoff}: ${error.message}`);
    return { ok: false, status: "error", error };
  }
}

export async function loadActiveAppointmentLocks(limit = 20) {
  if (!isDatabaseEnabled()) return [];
  const now = new Date().toISOString();
  const rows = await supabaseFetch(
    `/rest/v1/appointment_locks?select=id,slot_start,slot_end,phone_number,expires_at,created_at&expires_at=gt.${encodeURIComponent(
      now
    )}&order=expires_at.asc&limit=${limit}`
  );

  return (rows ?? []).map((row) => ({
    id: row.id,
    slotStart: row.slot_start,
    slotEnd: row.slot_end,
    phoneNumber: row.phone_number,
    expiresAt: row.expires_at,
    createdAt: row.created_at
  }));
}

async function insertAppointmentLock(payload) {
  const rows = await supabaseFetch("/rest/v1/appointment_locks?select=id,lock_token,slot_start,slot_end,expires_at", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(payload)
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
}

async function getAppointmentLockForSlot(slotStart, slotEnd) {
  const rows = await supabaseFetch(
    `/rest/v1/appointment_locks?select=id,slot_start,slot_end,phone_number,expires_at&slot_start=eq.${encodeURIComponent(
      slotStart
    )}&slot_end=eq.${encodeURIComponent(slotEnd)}&limit=1`
  );
  const row = rows?.[0];
  if (!row) return null;
  return {
    id: row.id,
    slotStart: row.slot_start,
    slotEnd: row.slot_end,
    phoneNumber: row.phone_number,
    expiresAt: row.expires_at
  };
}

async function deleteAppointmentLockById(id) {
  await supabaseFetch(`/rest/v1/appointment_locks?id=eq.${encodeURIComponent(id)}`, {
    method: "DELETE"
  });
}

function isExpiredLock(lock, now = new Date()) {
  return new Date(lock.expiresAt).getTime() <= now.getTime();
}

function isDuplicateKeyError(error) {
  const message = String(error?.message ?? error ?? "").toLowerCase();
  return message.includes("409") || message.includes("23505") || message.includes("duplicate key") || message.includes("unique constraint");
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
  if ((citaData.status ?? "confirmed") === "confirmed" && !String(citaData.googleEventId ?? "").trim()) {
    throw new Error("google_event_id is required for confirmed appointments");
  }
  if ((citaData.status ?? "confirmed") === "confirmed") {
    await failUnlinkedConfirmedCitasBetween(
      citaData.slotStart,
      citaData.slotEnd,
      "Auto-expirada: cita confirmada sin google_event_id antes de guardar una cita real."
    );
  }

  let rows;
  try {
    rows = await insertCitaPayload(buildCitaPayload(citaData));
  } catch (error) {
    if (!isMissingCitaColumnError(error)) throw error;
    rows = await insertCitaPayload(buildCitaPayload(citaData, { legacy: true }));
  }

  const row = rows?.[0];
  if (!row) return null;
  return {
    id: row.id,
    phoneNumber: row.phone_number,
    googleEventId: row.google_event_id,
    slotStart: row.slot_start,
    slotEnd: row.slot_end,
    status: row.status
  };
}

export async function failUnlinkedConfirmedCitasBetween(startISO, endISO, errorMessage) {
  if (!isDatabaseEnabled() || !startISO || !endISO) return [];

  return await supabaseFetch(
    `/rest/v1/citas?status=eq.confirmed&slot_start=lt.${encodeURIComponent(endISO)}&slot_end=gt.${encodeURIComponent(
      startISO
    )}&or=(google_event_id.is.null,google_event_id.eq.)`,
    {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        status: "failed",
        error_message: String(errorMessage ?? "").slice(0, 500)
      })
    }
  );
}

export async function failUnlinkedConfirmedCitas(errorMessage) {
  if (!isDatabaseEnabled()) return [];

  return await supabaseFetch("/rest/v1/citas?status=eq.confirmed&or=(google_event_id.is.null,google_event_id.eq.)", {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({
      status: "failed",
      error_message: String(errorMessage ?? "").slice(0, 500)
    })
  });
}

function buildCitaPayload(citaData, { legacy = false } = {}) {
  const basePayload = {
    phone_number: citaData.phoneNumber,
    patient_name: citaData.patientName,
    patient_email: citaData.patientEmail,
    google_event_id: citaData.googleEventId,
    slot_start: citaData.slotStart,
    slot_end: citaData.slotEnd,
    status: citaData.status ?? "confirmed"
  };

  if (legacy) return basePayload;

  return {
    ...basePayload,
    first_visit: citaData.firstVisit,
    payment_type: citaData.paymentType,
    reason: citaData.reason,
    error_message: citaData.errorMessage
  };
}

async function insertCitaPayload(payload) {
  return await supabaseFetch("/rest/v1/citas?select=id,phone_number,google_event_id,slot_start,slot_end,status", {
    method: "POST",
    headers: {
      Prefer: "return=representation"
    },
    body: JSON.stringify(payload)
  });
}

function isMissingCitaColumnError(error) {
  const message = String(error?.message ?? error ?? "").toLowerCase();
  return (
    message.includes("pgrst204") ||
    message.includes("schema cache") ||
    (message.includes("could not find") && message.includes("column"))
  );
}

export async function getLatestConfirmedCitaByPhone(phoneNumber) {
  if (!isDatabaseEnabled()) return null;

  const rows = await supabaseFetch(
    `/rest/v1/citas?select=id,phone_number,patient_name,patient_email,google_event_id,slot_start,slot_end,status,first_visit,payment_type&phone_number=eq.${encodeURIComponent(
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
    status: row.status,
    firstVisit: row.first_visit,
    paymentType: row.payment_type
  };
}

export async function loadConfirmedCitasBetween(startISO, endISO) {
  if (!isDatabaseEnabled() || !startISO || !endISO) return [];

  const rows = await supabaseFetch(
    `/rest/v1/citas?select=id,slot_start,slot_end,status,google_event_id&status=eq.confirmed&slot_start=lt.${encodeURIComponent(
      endISO
    )}&slot_end=gt.${encodeURIComponent(startISO)}`
  );

  return (rows ?? [])
    .filter((row) => String(row.google_event_id ?? "").trim().length > 0)
    .map((row) => ({
      id: row.id,
      slotStart: row.slot_start,
      slotEnd: row.slot_end,
      status: row.status,
      googleEventId: row.google_event_id
    }));
}

export async function loadConfirmedCitasForReconciliation() {
  if (!isDatabaseEnabled()) return [];
  // Only future or recent (last 48h) citas with google_event_id
  const since = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  const rows = await supabaseFetch(
    `/rest/v1/citas?select=id,google_event_id,slot_start&status=eq.confirmed&google_event_id=not.is.null&slot_start=gt.${encodeURIComponent(since)}`
  );
  return (rows ?? [])
    .filter((row) => String(row.google_event_id ?? "").trim().length > 0)
    .map((row) => ({ id: row.id, googleEventId: row.google_event_id, slotStart: row.slot_start }));
}

export async function loadConfirmedCitasByDay(dateISO) {
  if (!isDatabaseEnabled() || !dateISO) return [];

  const dayStart = `${dateISO}T00:00:00.000Z`;
  const dayEnd = `${dateISO}T23:59:59.999Z`;

  const rows = await supabaseFetch(
    `/rest/v1/citas?select=id,slot_start,slot_end,status,google_event_id,phone_number,patient_name,patient_email&status=eq.confirmed&slot_start=lt.${encodeURIComponent(dayEnd)}&slot_end=gt.${encodeURIComponent(dayStart)}`
  );

  return (rows ?? []).map((row) => ({
    id: row.id,
    slotStart: row.slot_start,
    slotEnd: row.slot_end,
    status: row.status,
    googleEventId: row.google_event_id,
    phoneNumber: row.phone_number,
    patientName: row.patient_name,
    patientEmail: row.patient_email
  }));
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

export async function saveWaitlistEntry(entry) {
  if (!isDatabaseEnabled()) return;

  await supabaseFetch("/rest/v1/waitlist_entries", {
    method: "POST",
    body: JSON.stringify({
      phone_number: entry.phoneNumber,
      patient_name: entry.patientName,
      desired_date: entry.desiredDate,
      desired_range: entry.desiredRange,
      service: entry.service,
      status: entry.status ?? "waiting"
    })
  });
}

export async function loadWaitingListByDate(dateISO, limit = 5) {
  if (!isDatabaseEnabled() || !dateISO) return [];

  const rows = await safeSupabaseFetch(
    `/rest/v1/waitlist_entries?select=id,phone_number,patient_name,desired_date,desired_range,service,status,created_at&desired_date=eq.${encodeURIComponent(
      dateISO
    )}&status=eq.waiting&order=created_at.asc&limit=${limit}`
  );

  return (rows ?? []).map((row) => ({
    id: row.id,
    phoneNumber: row.phone_number,
    patientName: row.patient_name,
    desiredDate: row.desired_date,
    desiredRange: row.desired_range,
    service: row.service,
    status: row.status,
    createdAt: row.created_at
  }));
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
