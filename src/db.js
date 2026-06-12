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
  const byPhone = new Map();
  for (const conversation of conversations) {
    byPhone.set(conversation.phone_number, {
      phoneNumber: conversation.phone_number,
      updatedAt: conversation.updated_at,
      messages: []
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

  return [...byPhone.values()];
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
