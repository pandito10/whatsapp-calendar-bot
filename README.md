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
node src/server.js
```

No usa dependencias externas de npm; solo necesita Node.js moderno con `fetch`.

En Meta, configura el webhook:

```text
https://TU-DOMINIO/webhook
```

El verify token debe ser el mismo valor que `WHATSAPP_VERIFY_TOKEN`.

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

- `APPOINTMENT_MINUTES`: duracion de cada cita. Para este consultorio queda en 40.
- `WORK_DAYS`: dias laborales, donde 1=lunes y 5=viernes.
- `WORK_START`: hora de inicio.
- `WORK_END`: hora de cierre.
- `DOCTOR_WHATSAPP_NUMBER`: numero de tu tia con codigo de pais.

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

El bot seguira funcionando aunque Supabase falle; en ese caso usa memoria temporal como respaldo.

## Nota medica

El bot no debe diagnosticar ni pedir informacion sensible innecesaria. Para urgencias, siempre debe indicar que el paciente contacte directamente al consultorio o acuda a urgencias.
