# Pruebas manuales del piloto

Usa una URL base:

```bash
BASE_URL="https://TU-DOMINIO"
WEBHOOK_SECRET_PATH="TU_WEBHOOK_PATH_SECRET"
APP_SECRET="TU_WHATSAPP_APP_SECRET"
PHONE_NUMBER_ID="TU_WHATSAPP_PHONE_NUMBER_ID"
INBOX_PASSWORD="TU_PASSWORD"
```

## Smoke automatico recomendado

Antes de probar con pacientes reales, corre:

```bash
BASE_URL="$BASE_URL" \
WEBHOOK_PATH_SECRET="$WEBHOOK_SECRET_PATH" \
WHATSAPP_APP_SECRET="$APP_SECRET" \
WHATSAPP_PHONE_NUMBER_ID="$PHONE_NUMBER_ID" \
WHATSAPP_BUSINESS_ACCOUNT_ID="WABA_ID_DE_PRUEBA" \
WHATSAPP_DISPLAY_PHONE_NUMBER="4778137806" \
npm run smoke:pilot
```

Valida:

- `/health/live`
- `/health/ready`
- `/inbox` protegido
- webhook sin firma rechazado
- webhook con firma aceptado usando payload de status sin mensajes

Este smoke no envia mensajes reales a pacientes; solo verifica que el deploy y la seguridad base esten vivos.

## Payload de mensaje

Guarda esto como `/tmp/wa-message.json` y cambia `PHONE_NUMBER_ID`.

```json
{
  "object": "whatsapp_business_account",
  "entry": [
    {
      "id": "WABA_ID_DE_PRUEBA",
      "changes": [
        {
          "field": "messages",
          "value": {
            "metadata": {
              "display_phone_number": "4778137806",
              "phone_number_id": "TU_WHATSAPP_PHONE_NUMBER_ID"
            },
            "messages": [
              {
                "id": "wamid.TEST_UNICO_001",
                "from": "5214770000000",
                "type": "text",
                "text": { "body": "hola" }
              }
            ]
          }
        }
      ]
    }
  ]
}
```

## Payload de status sin mensajes

Guarda esto como `/tmp/wa-status.json`.

```json
{
  "object": "whatsapp_business_account",
  "entry": [
    {
      "id": "WABA_ID_DE_PRUEBA",
      "changes": [
        {
          "field": "messages",
          "value": {
            "metadata": {
              "display_phone_number": "4778137806",
              "phone_number_id": "TU_WHATSAPP_PHONE_NUMBER_ID"
            },
            "statuses": [
              { "id": "wamid.STATUS_001", "status": "sent", "timestamp": "1710000000" }
            ]
          }
        }
      ]
    }
  ]
}
```

## Firma HMAC valida

```bash
SIG="$(node scripts/sign-webhook.js "$APP_SECRET" /tmp/wa-message.json)"
curl -i "$BASE_URL/webhook/$WEBHOOK_SECRET_PATH" \
  -H "Content-Type: application/json" \
  -H "X-Hub-Signature-256: $SIG" \
  --data-binary @/tmp/wa-message.json
```

Debe responder `200 ok`.

## Firma invalida

```bash
curl -i "$BASE_URL/webhook/$WEBHOOK_SECRET_PATH" \
  -H "Content-Type: application/json" \
  -H "X-Hub-Signature-256: sha256=bad" \
  --data-binary @/tmp/wa-message.json
```

Debe responder `403 forbidden`.

## Sin firma

Con `ALLOW_UNSIGNED_WEBHOOKS=false` debe responder `403`.

```bash
curl -i "$BASE_URL/webhook/$WEBHOOK_SECRET_PATH" \
  -H "Content-Type: application/json" \
  --data-binary @/tmp/wa-message.json
```

## Ruta secreta

Si `WEBHOOK_PATH_SECRET` esta configurado, `/webhook` no debe aceptar POST.

```bash
curl -i "$BASE_URL/webhook" \
  -H "Content-Type: application/json" \
  --data-binary @/tmp/wa-message.json
```

Debe responder `404 not found`.

## phone_number_id incorrecto

Cambia `phone_number_id` en el JSON a un valor falso, firma de nuevo y manda el POST.
Debe responder `403 forbidden`.

## Status sin mensajes

```bash
SIG="$(node scripts/sign-webhook.js "$APP_SECRET" /tmp/wa-status.json)"
curl -i "$BASE_URL/webhook/$WEBHOOK_SECRET_PATH" \
  -H "Content-Type: application/json" \
  -H "X-Hub-Signature-256: $SIG" \
  --data-binary @/tmp/wa-status.json
```

Debe responder `200 ok` y no debe disparar logica del bot.

## Dedupe

Manda dos veces el mismo `/tmp/wa-message.json` con el mismo `messages[0].id`.
La primera vez se procesa. La segunda debe responder `200 ok`, pero no debe reprocesar ni enviar otra respuesta.

## Inbox

```bash
curl -i "$BASE_URL/inbox"
```

Debe redirigir a `/inbox/login`.

Para entrar desde navegador, abre:

```text
https://TU-DOMINIO/inbox
```

Pruebas:

- Login incorrecto varias veces debe rate-limitear.
- `/inbox/send` sin cookie debe responder `403`.
- `/inbox/send` sin CSRF debe responder `403`.
- Al enviar desde el inbox, el mensaje debe guardarse solo si WhatsApp API responde bien.

## Modo humano

1. Abre una conversacion en `/inbox`.
2. Pulsa `Tomar conversacion`.
3. Envia un WhatsApp desde el paciente.
4. Debe guardarse en inbox, pero el bot no debe responder automatico.
5. Pulsa `Devolver al bot`.
6. El siguiente mensaje del paciente debe volver a responder con el bot.

## Agenda y cancelacion

- Pedir una cita debe crear evento en Google Calendar y fila `confirmed` en Supabase.
- Intentar el mismo horario dos veces no debe crear doble cita por el indice unico de `slot_start where status='confirmed'`.
- Si Google Calendar falla, el bot no debe confirmar.
- Si Supabase falla despues de crear Google Calendar, el bot intenta cancelar el evento recien creado y no confirma al paciente.
- Enviar `quiero cancelar mi cita` debe cancelar Google Calendar si hay `google_event_id` y marcar `citas.status='cancelled'`.

## Limpieza dedupe

En Supabase SQL Editor:

```sql
select public.cleanup_processed_whatsapp_messages(30);
```
