#!/usr/bin/env node
// scripts/create-whatsapp-templates.js
// Crea las 3 plantillas de recordatorio/cancelación en WhatsApp Business Cloud API.
// Uso: WHATSAPP_BUSINESS_ACCOUNT_ID=xxx WHATSAPP_ACCESS_TOKEN=yyy node scripts/create-whatsapp-templates.js

const { WHATSAPP_BUSINESS_ACCOUNT_ID, WHATSAPP_ACCESS_TOKEN } = process.env;

if (!WHATSAPP_BUSINESS_ACCOUNT_ID) {
  console.error("❌  Falta WHATSAPP_BUSINESS_ACCOUNT_ID");
  process.exit(1);
}
if (!WHATSAPP_ACCESS_TOKEN) {
  console.error("❌  Falta WHATSAPP_ACCESS_TOKEN  (necesita permiso whatsapp_business_management)");
  process.exit(1);
}

const ENDPOINT = `https://graph.facebook.com/v25.0/${WHATSAPP_BUSINESS_ACCOUNT_ID}/message_templates`;

const TEMPLATES = [
  {
    name: "recordatorio_cita_24h",
    language: "es_MX",
    category: "UTILITY",
    components: [
      {
        type: "BODY",
        text: "Hola {{1}} 👋 Te recordamos tu cita para el {{2}}. Si necesitas reagendar o cancelar, respóndenos por este chat. ¡Te esperamos! 😊",
        example: {
          body_text: [["María", "miércoles 18 de junio 5:00 pm"]]
        }
      }
    ]
  },
  {
    name: "recordatorio_cita_2h",
    language: "es_MX",
    category: "UTILITY",
    components: [
      {
        type: "BODY",
        text: "Hola {{1}} 👋 Tu cita es hoy a las {{2}}. Si no puedes asistir, avísanos por este chat. ¡Te esperamos! 😊",
        example: {
          body_text: [["María", "5:00 pm"]]
        }
      }
    ]
  },
  {
    name: "cancelacion_cita",
    language: "es_MX",
    category: "UTILITY",
    components: [
      {
        type: "BODY",
        text: "Hola {{1}}, lamentamos informarte que tu cita ha sido cancelada. Por favor contáctanos por este chat para reagendar. Disculpa las molestias.",
        example: {
          body_text: [["María"]]
        }
      }
    ]
  }
];

async function createTemplate(template) {
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(template)
  });

  const data = await response.json();

  if (!response.ok || data.error) {
    const err = data.error ?? data;
    throw new Error(`${err.message ?? JSON.stringify(err)} (código ${err.code ?? response.status})`);
  }

  return data;
}

async function main() {
  console.log(`\n📋  Creando ${TEMPLATES.length} plantillas en cuenta ${WHATSAPP_BUSINESS_ACCOUNT_ID}...\n`);

  const results = [];

  for (const template of TEMPLATES) {
    process.stdout.write(`  → ${template.name} ... `);
    try {
      const data = await createTemplate(template);
      const status = data.status ?? "PENDING";
      console.log(`✅  id=${data.id}  estado=${status}`);
      results.push({ name: template.name, ok: true, id: data.id, status });
    } catch (error) {
      console.log(`❌  ${error.message}`);
      results.push({ name: template.name, ok: false, error: error.message });
    }
  }

  const created = results.filter(r => r.ok);
  const failed  = results.filter(r => !r.ok);

  console.log("\n─────────────────────────────────────────");
  console.log(`Resumen: ${created.length} creadas, ${failed.length} con error\n`);

  if (created.length > 0) {
    console.log("Creadas:");
    for (const r of created) {
      console.log(`  ✅  ${r.name}  (id=${r.id}, estado=${r.status})`);
    }
  }

  if (failed.length > 0) {
    console.log("\nErrores:");
    for (const r of failed) {
      console.log(`  ❌  ${r.name}: ${r.error}`);
    }
    console.log("\nNota: si el error dice 'already exists', la plantilla ya estaba creada — no es problema.");
  }

  if (created.length > 0) {
    console.log("\n⏱️  Las plantillas UTILITY suelen aprobarse en minutos.");
    console.log("   Verifica su estado en: https://business.facebook.com/wa/manage/message-templates/");
  }

  console.log("");
}

main().catch(err => {
  console.error("\n💥  Error inesperado:", err.message);
  process.exit(1);
});
