# WhatsApp Calendar Bot

MVP para que un consultorio agende citas automaticamente por WhatsApp y cree eventos en Google Calendar.

## Que hace

- Recibe mensajes de WhatsApp Cloud API por webhook.
- Muestra menu inicial con lista interactiva de WhatsApp y fallback numerado.
- Muestra fechas sugeridas con lista interactiva cuando pide el dia de la cita.
- Saluda diferente a pacientes recurrentes si ya hay una cita confirmada para ese telefono.
- Reutiliza datos basicos de pacientes recurrentes para que no empiecen desde cero.
- Marca conversaciones atoradas o esperando datos en el inbox para seguimiento humano.
- Pregunta nombre y fecha deseada.
- Consulta disponibilidad en Google Calendar.
- Ofrece hasta 6 horarios de 40 minutos con lista interactiva y fallback numerado.
- Pide confirmacion antes de agendar.
- Agenda automaticamente cuando el paciente confirma.
- Notifica a la doctora por WhatsApp.
- Guarda conversaciones y citas en Supabase cuando esta configurado.
- Muestra un inbox web con modo humano.
- Muestra diagnostico rapido en el inbox: WhatsApp, firma Meta, Supabase, Google, auth del inbox, recordatorios y locks activos.

## Lo que necesitas crear

1. Una app en Meta Developers con WhatsApp Cloud API.
2. Un numero de WhatsApp Business conectado a esa app.
3. Un Google Cloud Project con Calendar API habilitada.
4. OAuth de Google para obtener un refresh token del calendario de la doctora.
5. Opcional: una API key de IA. El MVP puede empezar gratis con `AI_PROVIDER=local`.
6. Un dominio publico HTTPS para el webhook. En desarrollo puedes usar ngrok.

## Produccion actual

El deploy activo de este piloto en Render es:

```text
https://whatsapp-calendar-bot-gw3e.onrender.com
```

URLs utiles:

```text
Health: https://whatsapp-calendar-bot-gw3e.onrender.com/health/ready
Inbox:  https://whatsapp-calendar-bot-gw3e.onrender.com/inbox/login
Meta:   https://whatsapp-calendar-bot-gw3e.onrender.com/webhook/TU_WEBHOOK_PATH_SECRET
```

No uses `https://whatsapp-calendar-bot.onrender.com` para este bot. Ese dominio puede apuntar a otro servicio y no debe configurarse en Meta.

El calendario oficial del piloto es la agenda de citas **DRA. CARRANZA**. El link de Google Appointment Schedule que usa el consultorio corresponde a `ginecologiaintegralgto@gmail.com`; por eso ese correo es el `GOOGLE_CALENDAR_ID` correcto.

```text
GOOGLE_CALENDAR_LABEL=agenda de citas DRA. CARRANZA
GOOGLE_CALENDAR_ID=ginecologiaintegralgto@gmail.com
GOOGLE_CALENDAR_EVENT_COLOR_ID=9
GOOGLE_CALENDAR_EVENT_SUMMARY_PREFIX=DRA. CARRANZA-
GOOGLE_BUSY_CALENDAR_IDS=ginecologiaintegralgto@gmail.com
```

`GOOGLE_CALENDAR_ID` es donde caen las nuevas citas del bot. `GOOGLE_BUSY_CALENDAR_IDS` bloquea disponibilidad contra ese mismo calendario. Solo agrega otros calendarios si el consultorio confirma que tambien deben bloquear horarios.
`GOOGLE_CALENDAR_EVENT_COLOR_ID=9` mantiene el color visual de las citas creadas por el bot.
`GOOGLE_CALENDAR_EVENT_SUMMARY_PREFIX=DRA. CARRANZA-` hace que el evento se vea con el mismo prefijo de la agenda oficial.

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
- Configura el token permanente en `WHATSAPP_TOKEN`. `WHATSAPP_ACCESS_TOKEN` queda como fallback legacy. Si ambas variables existen y son distintas, el bot usa `WHATSAPP_TOKEN` y `/health/ready` avisa `tokenConflict`.
- Si los mensajes entran pero el bot no responde, revisa `/health/ready` o `/debug/config`: ahi se muestra `whatsapp.tokenSource`, `webhook.lastRejectedReason`, `webhook.lastMessageAt` y `whatsapp.lastSend` sin enseñar secretos.
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
- El webhook deduplica mensajes por `message_id` para evitar reprocesar el mismo WhatsApp si Meta reintenta.
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
- Filtrar por pendientes, resultados, cita agendada, sin cita, primera vez, recurrentes o modo humano.
- Responder desde `/inbox` como humano.
- Enviar mensajes de texto por WhatsApp.
- Enviar fotos, PDF o archivos medicos por correo confirmado desde una accion separada y segura.
- Cerrar la conversacion seleccionada para volver a la vista neutral de pacientes.
- Tomar una conversacion para pausar el bot.
- Devolver la conversacion al bot.
- Ver aviso cuando la ultima interaccion del paciente fue hace mas de 24 horas.
- Revisar respuestas humanas como sugerencias de aprendizaje supervisado.

Las acciones del inbox requieren sesion y CSRF. Los mensajes humanos se envian por WhatsApp desde backend y se guardan solo despues de respuesta exitosa de la API.
El inbox ya no permite adjuntar fotos, videos, documentos ni PDFs por WhatsApp. Para cualquier archivo usa la accion **Enviar archivo por correo confirmado** en la ficha del paciente; envia PDF/JPG/PNG/WEBP al correo confirmado de la cita usando Resend. Supabase guarda solo una nota y metadata del envio, no el archivo completo.
Si una conversacion queda en modo humano mas de `BOT_PAUSE_TIMEOUT_MINUTES`, el bot la libera automaticamente al recibir un nuevo mensaje.

### Solicitud de resultados o estudios

El menu de WhatsApp incluye la opcion **Resultados**. Cuando una paciente la elige o escribe algo como "mis resultados", "mis estudios" o "mi diagnostico", el bot:

- Marca la conversacion con etiquetas `Resultados` y `Humano requerido`.
- Pausa el bot para que no mande documentos automaticamente.
- Guarda una nota interna para verificar identidad, correo confirmado y archivo aprobado.
- Responde a la paciente: "Por privacidad, los resultados o estudios se entregan unicamente por el correo confirmado de la paciente o de forma presencial. Por WhatsApp solo podemos registrar tu solicitud y pasarla a revision humana."
- Avisa al numero administrador sin incluir datos medicos en la alerta.

Regla de operacion: no enviar resultados, diagnosticos ni estudios solo por nombre. Antes de enviar un archivo, el personal debe verificar identidad, confirmar que el correo guardado pertenece a la paciente y confirmar que el documento fue aprobado por el consultorio. El archivo se manda por correo confirmado, no por WhatsApp. Si la ventana de 24 horas esta abierta, el sistema puede enviar por WhatsApp solo un aviso sin archivo; si la ventana cerro, deja solamente la nota interna.

Las FAQs aprobadas desde el inbox no pueden responder automaticamente temas medicos sensibles como diagnostico, receta, medicamentos, tratamiento, infeccion, embarazo, sangrado, dolor fuerte, resultados, estudios, relaciones sexuales, papanicolaou, colposcopia o ultrasonido. Esas preguntas deben configurarse como `human_handoff`.

## Aprendizaje supervisado

El bot no aprende solo. Cuando no entiende un mensaje, guarda una pregunta no reconocida con telefono, fecha, conversacion, categoria aproximada y estado `pending`.
Desde el inbox se puede:

- Escribir la respuesta correcta y aprobarla como FAQ.
- Marcarla como ignorada.
- Marcarla como "pasar siempre a humano".
- Editar FAQs aprobadas.
- Activar o desactivar FAQs.
- Borrar FAQs que ya no aplican.

Solo las respuestas `approved` y activas pueden usarse para contestar preguntas parecidas.
Tambien puedes agregar una FAQ manual desde el panel de aprendizaje: escribe la pregunta futura y la respuesta, y se guarda como `approved`.

Esto evita que el bot aprenda datos privados, errores humanos o informacion medica no revisada.

## Modo sin IA

El modo recomendado para este piloto es sin IA externa:

```text
AI_PROVIDER=local
```

Tambien se acepta `AI_PROVIDER=off`, `AI_PROVIDER=none` o dejarlo vacio; el sistema usara el parser local.

Este modo entiende mensajes reales de WhatsApp con reglas locales: "quiero cita mañana", "kiero cita", "q horarios tienen", "kuanto cuesta", "mis resultados", fechas tipo `15/06`, dias de la semana, respuestas `1`, `2` o `3`, cancelacion, reagendar, formas de pago, ubicacion, servicios, requisitos y urgencias medicas administrativas.

Cuando WhatsApp acepta mensajes interactivos, el saludo envia una lista con opciones como agendar, horarios, ubicacion, costos, pagos, servicios, humano y resultados. Si el telefono ya tiene una cita confirmada, el bot muestra un menu de paciente recurrente y puede reutilizar nombre/correo guardados. Cuando pide fecha, muestra fechas sugeridas en una lista interactiva y evita sugerir dias cerrados. Cuando muestra horarios disponibles, tambien envia una lista interactiva para elegir horario. Las confirmaciones importantes usan botones. Si Meta rechaza el formato interactivo o hay algun error temporal, el bot cae automaticamente a texto para no detener la conversacion.

No usa Gemini, OpenAI, embeddings ni modelos externos para responder cuando `AI_PROVIDER=local/off/none`.

## Conectar IA opcional en otra fase

El codigo conserva compatibilidad opcional con Gemini/OpenAI para quien quiera probarlo despues, pero no es necesario para el piloto actual.

### Conectar Gemini opcional

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

### Conectar OpenAI opcional

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
- `CLINIC_TIMEZONE`: zona horaria del consultorio. Default: `America/Mexico_City`.
- `CLINIC_ADDRESS`: direccion mostrada al paciente. Si queda vacia, el bot responde que el consultorio la compartira directamente.
- `DOCTOR_WHATSAPP_NUMBER`: numero de tu tia con codigo de pais.

Defaults actuales del consultorio:

```text
APPOINTMENT_DURATION_MINUTES=40
CLINIC_WORK_DAYS=1,2,3,4,5
CLINIC_START_TIME=16:40
CLINIC_END_TIME=20:00
CLINIC_TIMEZONE=America/Mexico_City
MAX_OFFERED_SLOTS=6
CONSULTATION_PRICE=1000
PROMOTION_PRICE=1200
CLINIC_ADDRESS=
```

Las fechas relativas como `hoy`, `mañana` y `pasado mañana` se interpretan con `CLINIC_TIMEZONE`, no con la zona horaria del servidor de Render.

## Privacidad en Google Calendar

El evento se crea con un titulo neutral:

```text
DRA. CARRANZA- (Nombre)
```

Por default no se manda motivo medico a Google Calendar. Tampoco se incluye telefono completo salvo que actives variables explicitas.

Para mantener privacidad en un consultorio medico, deja en produccion:

```env
INCLUDE_SENSITIVE_APPOINTMENT_NOTES=false
INCLUDE_PATIENT_CONTACT_IN_CALENDAR=false
MASK_PATIENT_PHONE_IN_CALENDAR=true
```

Si decides guardar mas datos en Calendar, hazlo solo con autorizacion del consultorio y aviso de privacidad.

## Recordatorios por WhatsApp

WhatsApp Cloud API no permite mandar mensajes libres cuando ya paso la ventana de atencion de 24 horas. Para evitar bloqueos o fallos, los recordatorios al paciente estan desactivados por default salvo que configures templates aprobados por Meta.

Modo seguro por default:

```env
ENABLE_REMINDER_WORKER=false
ENABLE_PATIENT_REMINDER_TEMPLATES=false
WHATSAPP_REMINDER_TEMPLATE_24H=
WHATSAPP_REMINDER_TEMPLATE_2H=
WHATSAPP_REENGAGEMENT_TEMPLATE=
WHATSAPP_RESULTS_EMAIL_TEMPLATE=
WHATSAPP_TEMPLATE_LANGUAGE=es_MX
```

Cuando Meta apruebe tus templates, puedes activar:

```env
ENABLE_REMINDER_WORKER=true
ENABLE_PATIENT_REMINDER_TEMPLATES=true
WHATSAPP_REMINDER_TEMPLATE_24H=nombre_template_24h
WHATSAPP_REMINDER_TEMPLATE_2H=nombre_template_2h
WHATSAPP_REENGAGEMENT_TEMPLATE=retomar_conversacion
WHATSAPP_RESULTS_EMAIL_TEMPLATE=resultados_enviados_correo
WHATSAPP_TEMPLATE_LANGUAGE=es_MX
```

Los templates actuales reciben dos variables en el cuerpo: nombre del paciente y fecha/hora de la cita. Si tu template usa otro orden o mas variables, ajusta `sendReminder` antes de activarlo.

Para pacientes reales, manten `ENABLE_REMINDER_WORKER=false` hasta tener templates aprobados y probados. Los recordatorios a pacientes con templates quedan como segunda fase operativa segura.

Plantillas sugeridas para crear en Meta Business Manager:

- `retomar_conversacion` (Utility): `Hola {{1}}, seguimos pendientes para ayudarte desde el consultorio. Por favor responde este mensaje para continuar la conversacion.` Botones: `Continuar`, `Hablar con persona`.
- `resultados_enviados_correo` (Utility): `Hola {{1}}, tus documentos del consultorio fueron enviados al correo confirmado {{2}}. Por favor revisa bandeja de entrada y spam. Este chat no interpreta resultados ni sustituye consulta medica.` Botones: `Recibido`, `Necesito ayuda`.
- `recordatorio_cita_24h` (Utility): `Hola {{1}}, te recordamos tu cita: {{2}}. Si necesitas cambiarla o cancelarla, responde este mensaje.`
- `recordatorio_cita_2h` (Utility): `Hola {{1}}, te esperamos hoy a las {{2}} para tu cita. Si no puedes asistir, responde este mensaje.`
- `cancelacion_cita` (Utility): `Hola {{1}}, necesitamos avisarte que tu cita fue cancelada por el consultorio. Responde este mensaje para ayudarte a reagendar.`

Desde el inbox aparece una seccion "Plantillas Meta". Si la ventana de 24 horas ya cerro, usa esos botones en lugar de texto libre. Si una plantilla aparece como "Falta ...", primero crea y aprueba la plantilla en Meta y luego coloca el nombre exacto en Render.

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

El schema tambien agrega un indice unico para evitar dos citas confirmadas con el mismo `slot_start`, una tabla `appointment_locks` para apartar temporalmente un horario mientras se revalida Calendar y una tabla `waitlist_entries` para lista de espera.

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

Ejecuta pruebas del parser, reglas de agenda, seguridad y privacidad:

```bash
npm test
```

Estas pruebas cubren intencion de agendar, menu, seleccion de horario por numero y texto, rangos horarios sin IA, horario valido, fin de semana, duracion incorrecta, anticipacion minima, firma Meta, webhook firmado/sin firma, dedupe persistente, locks de Supabase, lista de espera, etiquetas, inbox protegido, redaccion de secretos, salud del servicio, timezone del consultorio, privacidad en Google Calendar, ubicacion configurable, recordatorios seguros y configuracion critica de produccion.

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
- `REQUIRE_SUPABASE_FOR_APPOINTMENTS=true` tambien es soportado como alias explicito.
- `CLINIC_TIMEZONE=America/Mexico_City`.
- `CLINIC_ADDRESS` configurada o fallback aprobado por el consultorio.
- `INCLUDE_SENSITIVE_APPOINTMENT_NOTES=false` para no enviar motivos delicados a Google Calendar.
- `MASK_PATIENT_PHONE_IN_CALENDAR=true`.
- `ENABLE_PATIENT_REMINDER_TEMPLATES=false` hasta tener templates aprobados por Meta.
- `ENABLE_REMINDER_WORKER=false` hasta validar templates de WhatsApp.
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

Los resultados medicos deben enviarse por correo confirmado desde el flujo seguro del inbox. El bot no guarda el archivo completo en Supabase; solo guarda nota interna y metadata de auditoria basica como correo enmascarado y nombre de archivo. No uses envio automatico de resultados: deben pasar por verificacion humana. WhatsApp solo debe usarse para avisar sin adjunto cuando la ventana de 24 horas siga abierta.

El bot es asistente administrativo: no diagnostica, no receta, no interpreta resultados y no sustituye una consulta. Para dudas medicas responde de forma segura y deriva a persona del consultorio; para urgencias indica acudir a urgencias.

## Hardening técnico agregado

Esta versión endurecida agrega varias protecciones para poder probar el robot con menos riesgo en un consultorio real:

- `/health` ahora responde JSON diagnóstico con HTTP 200; usa `/health/ready` para readiness estricta con 503 si falta configuración crítica.
- `/health/live` queda como liveness simple para saber si el proceso está vivo.
- Las llamadas externas a Google, Supabase y WhatsApp usan timeout configurable con `EXTERNAL_REQUEST_TIMEOUT_MS`.
- Los reintentos se aplican solo donde son prudentes. No se reintenta automáticamente el envío de WhatsApp ni la creación de eventos para evitar duplicados.
- El inbox ya no permite acceso por `?token=` ni `Authorization: Bearer` salvo que se active explícitamente `INBOX_ALLOW_LEGACY_TOKEN_ACCESS=true`.
- La firma de Meta se valida con helper aislado y pruebas automatizadas.
- Los errores redactan tokens, claves y teléfonos antes de mostrarse en logs.
- El inbox muestra estado visual de DB, Google y firma Meta en la barra superior.
- El inbox muestra estadisticas basicas: conversaciones, citas, seguimiento, modo humano, urgentes y pacientes sin respuesta.
- El inbox incluye un diagnostico rapido para que recepcion vea si WhatsApp, Supabase, Google, firma Meta, auth del inbox y recordatorios estan sanos.
- El inbox distingue pasos finos del flujo: esperando nombre, correo, servicio, tipo de consulta, fecha, horario o paciente atorada.
- El inbox permite editar FAQs, activar/desactivar, borrar, agregar variaciones y asignar etiquetas manuales a conversaciones.
- El bot guarda preguntas no reconocidas como pendientes para convertirlas en FAQ desde el inbox.
- El bot detecta solicitudes de resultados/estudios, pausa automatizacion y las manda a revision humana segura.
- La agenda soporta buffer entre citas y minimo de anticipacion configurable.
- Si no hay horarios disponibles, puede guardar a la paciente en lista de espera.

### Variables nuevas

```env
EXTERNAL_REQUEST_TIMEOUT_MS=8000
EXTERNAL_REQUEST_RETRIES=2
INBOX_ALLOW_LEGACY_TOKEN_ACCESS=false
INBOX_MEDIA_MAX_BYTES=16000000
RESULTS_EMAIL_MAX_BYTES=10000000
APPOINTMENT_BUFFER_MINUTES=0
MIN_APPOINTMENT_ADVANCE_HOURS=0
FORWARD_CONVERSATION_BODIES=false
MASK_PATIENT_PHONE_IN_CALENDAR=true
INCLUDE_PATIENT_CONTACT_IN_CALENDAR=false
ENABLE_PATIENT_REMINDER_TEMPLATES=false
WHATSAPP_REMINDER_TEMPLATE_24H=
WHATSAPP_REMINDER_TEMPLATE_2H=
WHATSAPP_REENGAGEMENT_TEMPLATE=
WHATSAPP_RESULTS_EMAIL_TEMPLATE=
WHATSAPP_TEMPLATE_LANGUAGE=es_MX
```

Mantén `INBOX_ALLOW_LEGACY_TOKEN_ACCESS=false`, `FORWARD_CONVERSATION_BODIES=false`, `MASK_PATIENT_PHONE_IN_CALENDAR=true` e `INCLUDE_PATIENT_CONTACT_IN_CALENDAR=false` en producción. El acceso seguro al inbox debe ser por login y cookie `HttpOnly`.
En produccion tambien deben quedar `REQUIRE_WEBHOOK_SIGNATURE=true`, `ALLOW_UNSIGNED_WEBHOOKS=false`, `INCLUDE_SENSITIVE_APPOINTMENT_NOTES=false` y `COLD_LEAD_FOLLOWUP_ENABLED=false` salvo que exista una razon operativa revisada. `/debug/config` muestra warnings de politica medica sin exponer secretos.

### Pruebas

```bash
npm test
npm run test:watch
```

Las pruebas cubren parser básico, reglas de horario, firma Meta válida/inválida, redacción de secretos en logs y privacidad operativa.

### Segunda ronda técnica

Esta versión agrega módulos pequeños para hacer el robot más mantenible sin reescribirlo:

- `src/appointments.js`: valida selección de horario, arma mensajes seguros y clasifica errores de confirmación.
- `src/health.js`: arma el reporte operativo de `/health` con `app`, `checks`, `counters` y `problems`.
- `tests/appointments.test.js`: pruebas del flujo de confirmación sin tocar WhatsApp ni Calendar real.
- `tests/health.test.js`: pruebas del health operativo.

`/health` ahora sirve mejor para producción porque indica exactamente si el sistema está `ok` o `degraded`, y lista problemas como `database_required_unavailable`, `google_missing_config` o `webhook_signature_not_enforced`.

Total actual de pruebas: 54.


### Tercera ronda técnica: readiness y privacidad por default

Esta ronda agrega controles para acercar el robot a una prueba real con consultorio:

- `src/readiness.js` calcula si el entorno está `ready`, `almost-ready` o `not-ready`.
- `/health` incluye un bloque `readiness` con score y checks bloqueantes; `/health/ready` usa ese diagnóstico para devolver 503 cuando hay problemas críticos.
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
npm run smoke:pilot
npm run doctor
npm run hash:password -- una-clave-larga-y-segura
```

Antes de producción real, `npm run doctor` debe pasar en Render con variables reales y Supabase conectado.
