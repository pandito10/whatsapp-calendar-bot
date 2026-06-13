# Robot hardening report

## Objetivo

Dejar el robot más estable, seguro y presentable para probarlo con un consultorio real sin cambiar de stack ni reescribir todo.

## Cambios aplicados

### Estabilidad

- Se agregó `src/http.js` con `resilientFetch`.
- Las integraciones externas ahora usan timeout configurable.
- Los retries se aplican solo cuando son prudentes para evitar duplicados.
- Google `freeBusy` puede reintentar porque es una consulta de disponibilidad.
- La creación de eventos y el envío de WhatsApp no se reintentan automáticamente para evitar duplicaciones.

### Seguridad

- Se agregó `src/security.js` para validar firmas `X-Hub-Signature-256` de Meta de forma aislada y testeable.
- El inbox ya no acepta acceso por `?token=` ni `Authorization: Bearer` por default.
- Se agregó `INBOX_ALLOW_LEGACY_TOKEN_ACCESS=false` para mantener el modo viejo apagado.
- Se agregó redacción centralizada de tokens, secretos y teléfonos en errores.

### Health check

- `/health` ahora responde JSON con estado de app, base de datos, WhatsApp, Google, inbox y firma de webhook.
- `/health/ready` devuelve `503` si falta configuración crítica o si la DB es obligatoria y falla; `/health` queda como diagnóstico HTTP 200.
- `/health/live` queda como liveness simple.

### Inbox

- El dashboard muestra badges visuales para DB, Google y Meta.
- Se reforzó la idea de dashboard operativo: conversaciones, citas, seguimiento y estado del sistema.

### Pruebas

- Se agregaron pruebas para firma Meta válida e inválida.
- Se agregaron pruebas para redacción de secretos.
- Se agregó `npm run test:watch`.

## Archivos modificados

- `src/http.js`
- `src/security.js`
- `src/google.js`
- `src/whatsapp.js`
- `src/db.js`
- `src/calendar.js`
- `src/server.js`
- `src/config.js`
- `tests/security.test.js`
- `tests/http.test.js`
- `package.json`
- `.env.example`
- `render.yaml`
- `README.md`

## Pruebas ejecutadas

```bash
node --check src/server.js
node --check src/google.js
node --check src/db.js
node --check src/whatsapp.js
node --check src/calendar.js
npm test
```

Resultado: todas las pruebas pasaron.

## Variables nuevas

```env
EXTERNAL_REQUEST_TIMEOUT_MS=8000
EXTERNAL_REQUEST_RETRIES=2
INBOX_ALLOW_LEGACY_TOKEN_ACCESS=false
```

## Pendientes para llegar a 10/10 real

- Separar `server.js` en módulos sin cambiar comportamiento.
- Agregar pruebas de flujo completo del webhook con servidor HTTP.
- Agregar pruebas de doble booking con mock de Supabase.
- Mejorar el inbox separando HTML/CSS a `src/views/inbox.js`.
- Implementar alertas reales de incidentes técnicos.
- Ensayar restore/backup de Supabase.

## Segunda ronda mamalona

Esta ronda no cambia el stack ni reescribe el sistema. El objetivo fue subir confiabilidad sin romper el flujo actual.

### Nuevos módulos

- `src/appointments.js`: centraliza reglas puras del flujo de confirmación:
  - valida que el horario elegido sí venga de la lista ofrecida,
  - valida reglas del consultorio antes de confirmar,
  - genera mensajes de confirmación al paciente,
  - genera aviso al administrador sin exponer motivo médico literal,
  - clasifica errores de Calendar, Supabase, doble booking y WhatsApp.
- `src/health.js`: centraliza el reporte operativo de `/health`:
  - checks de DB, WhatsApp, Google, inbox y firma Meta,
  - contadores de memoria,
  - `problems[]` para saber exactamente qué está degradado.

### Citas más confiables

- La selección de horario ahora se valida con `validateSlotSelection` antes de intentar lock, Calendar o Supabase.
- Si el paciente responde un número fuera de la lista, el bot no intenta confirmar nada.
- Los mensajes administrativos no copian motivos médicos sensibles; solo avisan que el paciente compartió un motivo y que debe revisarse en inbox.
- Los errores de confirmación ahora se clasifican para soporte: `calendar`, `database`, `double_booking`, `whatsapp` o `unknown`.

### Health check más útil

`/health` ahora muestra:

- `app`: `ok` o `degraded`,
- `checks`: estado de servicios críticos,
- `counters`: conversaciones, sesiones y mensajes deduplicados en memoria,
- `problems`: lista concreta de problemas detectados.

Esto ayuda a Render, soporte y diagnóstico rápido.

### Startup más estricto

`src/config.js` ahora valida mejor:

- horarios con formato `HH:mm`,
- días laborales entre 0 y 6,
- inicio menor que fin,
- timeout externo entre 1 y 30 segundos,
- retries entre 0 y 5.

### Pruebas nuevas

Se agregaron:

- `tests/appointments.test.js`,
- `tests/health.test.js`.

Cobertura nueva:

- selección válida de horario,
- selección no ofrecida,
- aviso al admin sin motivo médico literal,
- confirmación al paciente con advertencia de urgencias,
- clasificación de errores,
- sanitización de textos,
- health ok,
- health degradado si DB requerida falla.

## Estado después de esta ronda

- Pruebas totales: 17
- Resultado: 17 pasan, 0 fallan
- Calificación técnica estimada: 9/10 para piloto controlado de un consultorio

## Lo que todavía falta para 10/10 real

- Extraer el render del inbox a `src/views/inbox.js`.
- Agregar pruebas HTTP end-to-end del webhook con servidor levantado.
- Crear mocks formales para Supabase y Google Calendar.
- Probar doble booking con dos confirmaciones simultáneas reales.
- Agregar monitoreo externo real: UptimeRobot, Better Stack, Render alerts o similar.
- Implementar auditoría de cambios en inbox.

## Tercera ronda: criterio 10/10 antes de producción

Cambios agregados:

- Se agregó `src/readiness.js` para evaluar si la configuración está lista para producción.
- `/health` ahora incluye `readiness.score`, `readiness.status`, checks y bloqueos operativos.
- `/health/live` devuelve `503` cuando el proceso está apagándose para que Render/monitoreo no lo considere sano durante cierre.
- Se agregó cierre elegante con `SIGTERM` y `SIGINT` para no cortar requests de golpe en deploy/restart.
- Se agregó `npm run doctor` para validar salud/readiness desde terminal antes de mandar tráfico real.
- Se agregó `npm run hash:password` para generar `INBOX_PASSWORD_HASH=sha256:...` sin guardar password plano.
- Los copias automáticas de conversación al admin ya no incluyen el texto completo por default; solo avisan que hay mensaje y piden revisar inbox.
- Se agregó `FORWARD_CONVERSATION_BODIES=false` para que el texto completo solo se habilite explícitamente fuera de producción.
- Se agregó `INCLUDE_PATIENT_CONTACT_IN_CALENDAR=false` para minimizar datos en Google Calendar por default.
- Se dejó de guardar el motivo de cita en Supabase cuando `INCLUDE_SENSITIVE_APPOINTMENT_NOTES=false`.
- La creación de payload de Google Calendar ahora es testeable con `buildCalendarEventPayload`.
- Pruebas subieron a 20 y cubren privacidad en Calendar y readiness de producción.

Resultado local validado:

```bash
node --check src/*.js
npm test
```

Resultado:

```text
20 pruebas pasaron
0 fallaron
```

Pendiente real para poder decir 10/10 operativo:

- Ejecutar `npm run doctor` en Render con variables reales.
- Hacer prueba real WhatsApp → Calendar → Supabase → Inbox con el número oficial.
- Probar doble booking con dos conversaciones simultáneas reales o con test de integración usando Supabase de staging.
- Configurar monitoreo externo contra `/health`, `/health/live` y `/health/ready`.
