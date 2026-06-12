import { config } from "./config.js";

const maxConversations = 50;
const maxMessagesPerConversation = 100;

export function isDatabaseEnabled() {
  return Boolean(config.supabaseUrl && config.supabaseServiceRoleKey);
}

export async function saveConversationMessage(phoneNumber, sender, body) {
  if (!isDatabaseEnabled()) return;

  const timestamp = new Date().toISOString();
  await supabaseFetch("/rest/v1/conversations?on_conflict=phone_number", {
    method: "POST",
    headers: {
      Prefer: "resolution=merge-duplicates"
    },
    body: JSON.stringify({
      phone_number: phoneNumber,
      updated_at: timestamp
    })
  });

  await supabaseFetch("/rest/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      phone_number: phoneNumber,
      sender,
      body,
      created_at: timestamp
    })
  });
}

export async function loadConversations() {
  if (!isDatabaseEnabled()) return undefined;

  const conversations = await supabaseFetch(
    `/rest/v1/conversations?select=phone_number,updated_at&order=updated_at.desc&limit=${maxConversations}`
  );
  if (conversations.length === 0) return [];

  const phoneNumbers = conversations.map((conversation) => conversation.phone_number);
  const messages = await supabaseFetch(
    `/rest/v1/messages?select=phone_number,sender,body,created_at&phone_number=in.(${phoneNumbers
      .map(encodeURIComponent)
      .join(",")})&order=created_at.asc`
  );
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
      reason: citaData.reason
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

async function safeSupabaseFetch(path, options = {}) {
  try {
    return await supabaseFetch(path, options);
  } catch (error) {
    console.warn("Supabase optional request failed:", error.message);
    return undefined;
  }
}

async function supabaseFetch(path, options = {}) {
  const response = await fetch(`${config.supabaseUrl.replace(/\/$/, "")}${path}`, {
    ...options,
    headers: {
      apikey: config.supabaseServiceRoleKey,
      Authorization: `Bearer ${config.supabaseServiceRoleKey}`,
      "Content-Type": "application/json",
      ...(options.headers ?? {})
    }
  });

  if (!response.ok) {
    throw new Error(`Supabase request failed: ${response.status} ${await response.text()}`);
  }

  if (response.status === 204) return undefined;
  const text = await response.text();
  return text ? JSON.parse(text) : undefined;
}
