# Despliegue estable en Render

El bot debe correr en una URL HTTPS fija. Render funciona bien para el piloto privado.

## Crear servicio

1. Sube el repo a GitHub.
2. En Render crea un `Blueprint` con `render.yaml` o un `Web Service`.
3. Configura:

```text
Build command: npm install
Start command: npm start
Health check path: /health
Plan: starter
```

## Variables obligatorias en Render

```text
NODE_ENV=production
PORT=10000
PUBLIC_BASE_URL=https://TU-SERVICIO.onrender.com

WHATSAPP_TOKEN=...
WHATSAPP_PHONE_NUMBER_ID=...
WHATSAPP_VERIFY_TOKEN=...
WHATSAPP_BUSINESS_ACCOUNT_ID=...
WHATSAPP_DISPLAY_PHONE_NUMBER=...
DOCTOR_WHATSAPP_NUMBER=521...

SUPABASE_URL=https://TU-PROYECTO.supabase.co
SUPABASE_SERVICE_ROLE_KEY=...

GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REFRESH_TOKEN=...
GOOGLE_CALENDAR_ID=primary

INBOX_PASSWORD=...
COOKIE_SECRET=...
```

`WHATSAPP_ACCESS_TOKEN` tambien funciona, pero para nuevos despliegues usa `WHATSAPP_TOKEN`.

## Variables recomendadas en produccion

```text
WHATSAPP_APP_SECRET=...
REQUIRE_WEBHOOK_SIGNATURE=true
ALLOW_UNSIGNED_WEBHOOKS=false
WEBHOOK_PATH_SECRET=un-secreto-largo-de-24-o-mas-caracteres

WEBHOOK_RATE_LIMIT_PER_MINUTE=120
WEBHOOK_PHONE_RATE_LIMIT_PER_MINUTE=10
INBOX_LOGIN_RATE_LIMIT_PER_15_MINUTES=5
INBOX_SEND_RATE_LIMIT_PER_MINUTE=20
INBOX_ACTION_RATE_LIMIT_PER_MINUTE=30
MAX_REQUEST_BYTES=128000

INBOX_SESSION_HOURS=8
BOT_PAUSE_TIMEOUT_MINUTES=120
ENABLE_REMINDER_WORKER=true
REMINDER_WORKER_INTERVAL_MS=60000

AI_PROVIDER=local
CLINIC_TIMEZONE=America/Mexico_City
CLINIC_NAME=Consultorio Ginecologico
APPOINTMENT_DURATION_MINUTES=40
CLINIC_WORK_DAYS=1,2,3,4,5
CLINIC_START_TIME=16:40
CLINIC_END_TIME=20:00
MAX_OFFERED_SLOTS=6
CONSULTATION_PRICE=1000
PROMOTION_PRICE=1200
CLINIC_ADDRESS=
```

## Modo temporal sin App Secret

Usalo solo si Meta no permite ver el App Secret todavia.

```text
ALLOW_UNSIGNED_WEBHOOKS=true
UNSIGNED_WEBHOOK_EXPIRES_AT=2026-06-15T06:00:00.000Z
WEBHOOK_PATH_SECRET=un-secreto-largo-de-24-o-mas-caracteres
WHATSAPP_APP_SECRET=
REQUIRE_WEBHOOK_SIGNATURE=true
```

Callback URL en Meta:

```text
https://TU-SERVICIO.onrender.com/webhook/TU_WEBHOOK_PATH_SECRET
```

Cuando Meta permita usar App Secret, cambia a modo seguro.

## Modo produccion seguro

```text
WHATSAPP_APP_SECRET=...
REQUIRE_WEBHOOK_SIGNATURE=true
ALLOW_UNSIGNED_WEBHOOKS=false
WEBHOOK_PATH_SECRET=un-secreto-largo-de-24-o-mas-caracteres
```

Callback URL en Meta:

```text
https://TU-SERVICIO.onrender.com/webhook/TU_WEBHOOK_PATH_SECRET
```

Verify token en Meta:

```text
WHATSAPP_VERIFY_TOKEN
```

## Supabase

Instalacion desde cero:

```text
supabase/schema.sql
```

Migracion para base existente:

```text
supabase/migration-existing.sql
```

Limpieza manual de dedupe:

```sql
select public.cleanup_processed_whatsapp_messages(30);
```

La `SUPABASE_SERVICE_ROLE_KEY` solo debe estar en Render/backend, nunca en frontend.

## Pruebas despues de desplegar

Health:

```bash
curl -i https://TU-SERVICIO.onrender.com/health
```

Inbox:

```text
https://TU-SERVICIO.onrender.com/inbox
```

Debug config requiere login o bearer:

```bash
curl -H "Authorization: Bearer TU_INBOX_PASSWORD" https://TU-SERVICIO.onrender.com/debug/config
```

Pruebas completas:

```text
docs/manual-tests.md
```

## Riesgos restantes

- Para vender como SaaS multi-consultorio falta multi-tenant real con `business_id`, RLS y admins por negocio.
- Falta panel de configuracion por consultorio; hoy se configura por variables de entorno.
- WhatsApp fuera de ventana de 24 horas puede requerir plantillas aprobadas por Meta.
- Antes de pacientes reales, el consultorio debe tener aviso de privacidad.
