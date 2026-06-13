# WhatsApp Calendar Bot

MVP para que un consultorio agende citas automaticamente por WhatsApp y cree eventos en Google Calendar.

## Que hace

- Recibe mensajes de WhatsApp Cloud API por webhook.
- Pregunta nombre y fecha deseada.
- Consulta disponibilidad en Google Calendar.
- Ofrece hasta 6 horarios de 40 minutos.
- Agenda automaticamente cuando el paciente elige.
- Notifica a la doctora por WhatsApp.

## Lo que necesitas crear

1. Una app en Meta Developers con WhatsApp Cloud API.
2. Un numero de WhatsApp Business conectado a esa app.
3. Un Google Cloud Project con Calendar API habilitada.
4. OAuth de Google para obtener un refresh token del calendario de la doctora.
5. Opcional: una API key de IA. El MVP puede empezar gratis con `AI_PROVIDER=local`.
6. Un dominio publico HTTPS para el webhook. En desarrollo puedes usar ngrok.

## Configuracion

```bash
cp .env.example .env
npm start
```

No usa dependencias externas de npm; solo necesita Node.js moderno con `fetch`. Las pruebas usan el runner nativo de Node.js.

En Meta, configura el webhook:

```text
https://TU-DOMINIO/webhook
```

Si configuras `WEBHOOK_PATH_SECRET`, usa esta Callback URL:

```text
https://TU-DOMINIO/webhook/TU_SECRETO_LARGO
```

El verify token debe ser el mismo valor que `WHATSAPP_VERIFY_TOKEN`.

El inbox y `/debug/config` usan una credencial separada:

```text
INBOX_PASSWORD=una-clave-distinta-al-verify-token
```

Para entrar al inbox abre:

```text
https://TU-DOMINIO/inbox
```

El sistema mostrara una pantalla de login y guardara una sesion segura en cookie `HttpOnly`.
El link viejo con `?token=...` solo debe usarse para entrar una vez; despues redirige sin dejar el token visible en la URL.

## Seguridad recomendada

- Configura `INBOX_PASSWORD` con una clave larga y diferente al verify token de Meta. En produccion es mejor usar `INBOX_PASSWORD_HASH=sha256:...`.
- Configura `COOKIE_SECRET` con al menos 32 caracteres.
- Configura `WHATSAPP_APP_SECRET` desde Meta Developers y usa `REQUIRE_WEBHOOK_SIGNATURE=true`.
- Modo temporal sin App Secret: usa `ALLOW_UNSIGNED_WEBHOOKS=true`, `WEBHOOK_PATH_SECRET` obligatorio y `UNSIGNED_WEBHOOK_EXPIRES_AT` con fecha corta.
- Modo final seguro:

```text
WHATSAPP_APP_SECRET=...
REQUIRE_WEBHOOK_SIGNATURE=true
ALLOW_UNSIGNED_WEBHOOKS=false
WEBHOOK_PATH_SECRET=un-secreto-largo-de-24-o-mas-caracteres
```

- `ALLOW_UNSIGNED_WEBHOOKS=false` es el **default seguro**. Si la variable no existe o tiene cualquier valor distinto de `true`, los webhooks sin firma son rechazados.
- El modo piloto implicito fue eliminado. Ya no se acepta ningun webhook sin firma por el solo hecho de no tener `WHATSAPP_APP_SECRET` configurado.
- Si `WHATSAPP_APP_SECRET` no existe y `ALLOW_UNSIGNED_WEBHOOKS` no es `true`, el servidor rechaza webhooks POST con `403`.
- Si `UNSIGNED_WEBHOOK_EXPIRES_AT` ya vencio, el servidor rechaza webhooks sin firma.
- El webhook valida `object`, `entry`, `changes`, `phone_number_id`, y opcionalmente `WHATSAPP_BUSINESS_ACCOUNT_ID` y `WHATSAPP_DISPLAY_PHONE_NUMBER`.
- No pongas `SUPABASE_SERVICE_ROLE_KEY`, tokens de Meta ni secretos de Google en frontend o capturas publicas.
- El servidor limita requests por minuto, rechaza cuerpos grandes y agrega headers basicos de seguridad.
- Para datos medicos/personales, comparte acceso al inbox solo con personal autorizado.
- Este canal es solo para agendar, cancelar y resolver dudas generales. No sustituye consulta medica.

### URLs de Meta Developers

Temporal sin App Secret:

```text
https://TU-DOMINIO/webhook/TU_WEBHOOK_PATH_SECRET
```

Variables temporales:

```text
ALLOW_UNSIGNED_WEBHOOKS=true
UNSIGNED_WEBHOOK_EXPIRES_AT=2026-06-15T06:00:00.000Z
WEBHOOK_PATH_SECRET=un-secreto-largo-de-24-o-mas-caracteres
```

Produccion segura:

```text
https://TU-DOMINIO/webhook/TU_WEBHOOK_PATH_SECRET
```

Variables de produccion:

```text
WHATSAPP_APP_SECRET=...
REQUIRE_WEBHOOK_SIGNATURE=true
ALLOW_UNSIGNED_WEBHOOKS=false
WEBHOOK_PATH_SECRET=un-secreto-largo-de-24-o-mas-caracteres
WHATSAPP_PHONE_NUMBER_ID=...
WHATSAPP_BUSINESS_ACCOUNT_ID=...
```

## Inbox operativo

El inbox permite:

- Ver conversaciones.
- Buscar por nombre o telefono.
- Filtrar por pendientes, cita agendada o modo humano.
- Responder desde `/inbox` como humano.
- Tomar una conversacion para pausar el bot.
- Devolver la conversacion al bot.
- Ver aviso cuando la ultima interaccion del paciente fue hace mas de 24 horas.
- Revisar respuestas humanas como sugerencias de aprendizaje supervisado.

Las acciones del inbox requieren sesion y CSRF. Los mensajes humanos se envian por WhatsApp desde backend y se guardan solo despues de respuesta exitosa de la API.
Si una conversacion queda en modo humano mas de `BOT_PAUSE_TIMEOUT_MINUTES`, el bot la libera automaticamente al recibir un nuevo mensaje.

## Aprendizaje supervisado

Cuando el personal responde desde el inbox, el sistema guarda una sugerencia con la ultima pregunta del paciente y la respuesta humana.
La sugerencia queda en estado `pending`: el bot no la usa automaticamente.
Desde el inbox se puede aprobar o rechazar. Solo las respuestas `approved` pueden usarse para contestar preguntas parecidas.

Esto evita que el bot aprenda datos privados, errores humanos o informacion medica no revisada.

## IA gratis para empezar

El bot puede funcionar sin pagar IA usando:

```text
AI_PROVIDER=local
```

Este modo entiende mensajes basicos como "quiero cita mañana", nombres, fechas tipo `15/06`, dias de la semana y respuestas `1`, `2` o `3`.

## Conectar Gemini opcional

Gemini es la opcion mas barata para empezar. Segun la pagina oficial de precios de Gemini API, `gemini-2.5-flash-lite` tiene capa gratis y, en pago, precios bajos por millon de tokens.

1. Crea una API key en Google AI Studio.
2. Pegala en `.env`:

```text
AI_PROVIDER=gemini
GEMINI_API_KEY=...
GEMINI_MODEL=gemini-2.5-flash-lite
```

3. En Render agrega esas mismas variables de entorno y redeploya.

4. Prueba que la IA entienda mensajes:

```bash
npm run test:ai -- "Hola, soy Ana y quiero una cita mañana"
```

Si Gemini falla o se queda sin saldo, el bot usa el extractor local como respaldo para no dejar de contestar.

## Conectar OpenAI opcional

1. Crea una API key en OpenAI.
2. Pegala en `.env`:

```text
AI_PROVIDER=openai
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o-mini
```

3. Prueba que la IA entienda mensajes:

```bash
npm run test:openai -- "Hola, soy Ana y quiero una cita mañana"
```

## Conectar Google Calendar

1. En Google Cloud, habilita Google Calendar API.
2. Crea un OAuth Client y agrega este redirect URI:

```text
http://localhost:3000/oauth/google/callback
```

3. Pega `GOOGLE_CLIENT_ID` y `GOOGLE_CLIENT_SECRET` en `.env`.
4. Genera el enlace de autorizacion:

```bash
npm run google:auth-url
```

5. Abre el enlace con la cuenta de Google Calendar de la doctora.
6. Copia el parametro `code` de la URL final y corre:

```bash
npm run google:token -- CODIGO_AQUI
```

7. Prueba disponibilidad:

```bash
npm run test:google -- "mañana"
```

## Reglas del consultorio

Edita estas variables en `.env`:

- `APPOINTMENT_DURATION_MINUTES`: duracion de cada cita. Para este consultorio queda en 40.
- `CLINIC_WORK_DAYS`: dias laborales, donde 1=lunes y 5=viernes.
- `CLINIC_START_TIME`: hora de inicio.
- `CLINIC_END_TIME`: hora de cierre.
- `DOCTOR_WHATSAPP_NUMBER`: numero de tu tia con codigo de pais.

Defaults actuales del consultorio:

```text
APPOINTMENT_DURATION_MINUTES=40
CLINIC_WORK_DAYS=1,2,3,4,5
CLINIC_START_TIME=16:40
CLINIC_END_TIME=20:00
MAX_OFFERED_SLOTS=6
CONSULTATION_PRICE=1000
PROMOTION_PRICE=1200
```

## Guardar conversaciones en Supabase

Sin base de datos, el inbox guarda conversaciones en memoria y se borra cuando Render reinicia. Para dejar historial permanente:

1. Crea un proyecto en Supabase.
2. Abre SQL Editor.
3. Pega y ejecuta el contenido de `supabase/schema.sql`.
4. En Render agrega estas variables:

```text
SUPABASE_URL=https://TU-PROYECTO.supabase.co
SUPABASE_SERVICE_ROLE_KEY=TU_SERVICE_ROLE_KEY
```

5. Redeploya el servicio.

Si Supabase falla, el inbox puede usar memoria temporal como respaldo. Para citas confirmadas en produccion, `REQUIRE_DB_FOR_APPOINTMENTS=true` obliga a tener Supabase funcionando antes de confirmar al paciente. Si falla el guardado, el bot no confirma al paciente y trata de cancelar el evento recien creado en Google Calendar.

El schema tambien agrega un indice unico para evitar dos citas confirmadas con el mismo `slot_start` y una tabla `appointment_locks` para apartar temporalmente un horario mientras se revalida Calendar y se confirma la cita.

Para instalar desde cero, corre todo:

```text
supabase/schema.sql
```

Para una base existente, corre:

```text
supabase/migration-existing.sql
```

Para limpiar dedupe viejo:

```sql
select public.cleanup_processed_whatsapp_messages(30);
```

Para limpiar locks vencidos:

```sql
select public.cleanup_expired_appointment_locks();
```

## Pruebas automatizadas

Ejecuta pruebas basicas del parser y reglas de agenda:

```bash
npm test
```

Estas pruebas cubren intencion de agendar, seleccion de horario, horario valido, fin de semana y duracion incorrecta.

## Pruebas manuales

La guia completa esta en:

```text
docs/manual-tests.md
```

Incluye pruebas de:

- webhook con firma valida e invalida
- ruta secreta
- `phone_number_id`
- payload de status sin mensajes
- dedupe
- inbox
- modo humano
- agenda
- cancelacion

## Checklist antes de produccion

- App Secret activo.
- `REQUIRE_WEBHOOK_SIGNATURE=true`.
- `ALLOW_UNSIGNED_WEBHOOKS=false`.
- `WEBHOOK_PATH_SECRET` configurado y Callback URL actualizada en Meta.
- `WHATSAPP_PHONE_NUMBER_ID` validado.
- `WHATSAPP_BUSINESS_ACCOUNT_ID` configurado.
- `COOKIE_SECRET` fuerte.
- `INBOX_PASSWORD_HASH` o password fuerte.
- Supabase con backups.
- `supabase/schema.sql` ejecutado.
- `REQUIRE_DB_FOR_APPOINTMENTS=true` en produccion.
- `INCLUDE_SENSITIVE_APPOINTMENT_NOTES=false` para no enviar motivos delicados a Google Calendar.
- `npm test` pasando.
- Logs sin datos sensibles completos.
- Aviso de privacidad listo.
- RLS/multi-tenant antes de vender a varios consultorios.

## Privacidad y uso responsable

Este canal es solo para agendar, cancelar citas y resolver dudas generales. No sustituye una consulta medica. Si hay urgencia, el paciente debe acudir a urgencias o comunicarse directamente con el consultorio.

Datos que puede guardar:

- telefono
- mensajes de WhatsApp
- nombre del paciente
- correo para Google Calendar
- fecha/hora de cita
- datos administrativos como primera vez o tipo de pago

Terceros involucrados:

- Meta/WhatsApp
- Google Calendar
- Supabase
- Render

Recomendacion: antes de usarlo con pacientes reales, prepara un aviso de privacidad del consultorio. Evita pedir sintomas, diagnosticos o informacion intima por WhatsApp. No uses este bot como expediente medico. Por default, el motivo que escriba el paciente no se manda a Google Calendar ni al aviso de admin; se recomienda revisar detalles sensibles solo en el inbox con personal autorizado.

## Hardening técnico agregado

Esta versión endurecida agrega varias protecciones para poder probar el robot con menos riesgo en un consultorio real:

- `/health` ahora responde JSON y marca `503` si falta configuración crítica o si la base es obligatoria y no está disponible.
- `/health/live` queda como liveness simple para saber si el proceso está vivo.
- Las llamadas externas a Google, Supabase y WhatsApp usan timeout configurable con `EXTERNAL_REQUEST_TIMEOUT_MS`.
- Los reintentos se aplican solo donde son prudentes. No se reintenta automáticamente el envío de WhatsApp ni la creación de eventos para evitar duplicados.
- El inbox ya no permite acceso por `?token=` ni `Authorization: Bearer` salvo que se active explícitamente `INBOX_ALLOW_LEGACY_TOKEN_ACCESS=true`.
- La firma de Meta se valida con helper aislado y pruebas automatizadas.
- Los errores redactan tokens, claves y teléfonos antes de mostrarse en logs.
- El inbox muestra estado visual de DB, Google y firma Meta en la barra superior.

### Variables nuevas

```env
EXTERNAL_REQUEST_TIMEOUT_MS=8000
EXTERNAL_REQUEST_RETRIES=2
INBOX_ALLOW_LEGACY_TOKEN_ACCESS=false
FORWARD_CONVERSATION_BODIES=false
MASK_PATIENT_PHONE_IN_CALENDAR=true
INCLUDE_PATIENT_CONTACT_IN_CALENDAR=false
```

Mantén `INBOX_ALLOW_LEGACY_TOKEN_ACCESS=false`, `FORWARD_CONVERSATION_BODIES=false`, `MASK_PATIENT_PHONE_IN_CALENDAR=true` e `INCLUDE_PATIENT_CONTACT_IN_CALENDAR=false` en producción. El acceso seguro al inbox debe ser por login y cookie `HttpOnly`.

### Pruebas

```bash
npm test
npm run test:watch
```

Las pruebas cubren parser básico, reglas de horario, firma Meta válida/inválida y redacción de secretos en logs.

### Segunda ronda técnica

Esta versión agrega módulos pequeños para hacer el robot más mantenible sin reescribirlo:

- `src/appointments.js`: valida selección de horario, arma mensajes seguros y clasifica errores de confirmación.
- `src/health.js`: arma el reporte operativo de `/health` con `app`, `checks`, `counters` y `problems`.
- `tests/appointments.test.js`: pruebas del flujo de confirmación sin tocar WhatsApp ni Calendar real.
- `tests/health.test.js`: pruebas del health operativo.

`/health` ahora sirve mejor para producción porque indica exactamente si el sistema está `ok` o `degraded`, y lista problemas como `database_required_unavailable`, `google_missing_config` o `webhook_signature_not_enforced`.

Total actual de pruebas: 20.


### Tercera ronda técnica: readiness y privacidad por default

Esta ronda agrega controles para acercar el robot a una prueba real con consultorio:

- `src/readiness.js` calcula si el entorno está `ready`, `almost-ready` o `not-ready`.
- `/health` ahora incluye un bloque `readiness` con score y checks bloqueantes.
- `/health/live` responde `503` durante cierre elegante para reinicios/deploys más seguros.
- El servidor escucha `SIGTERM` y `SIGINT` para cerrar de forma ordenada en Render.
- `npm run doctor` valida configuración y salud antes de usar pacientes reales.
- `npm run hash:password -- <clave>` genera `INBOX_PASSWORD_HASH=sha256:...`.
- Por default no se reenvía el contenido completo de conversaciones al admin; se recomienda revisar el inbox.
- Por default no se guarda el motivo médico en Supabase ni se manda a Calendar.
- Por default el teléfono queda enmascarado en Calendar, salvo que se active explícitamente `INCLUDE_PATIENT_CONTACT_IN_CALENDAR=true`.

Comandos útiles:

```bash
npm test
npm run doctor
npm run hash:password -- una-clave-larga-y-segura
```

Antes de producción real, `npm run doctor` debe pasar en Render con variables reales y Supabase conectado.
