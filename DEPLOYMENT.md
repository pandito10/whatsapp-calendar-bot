# Despliegue estable

El bot ya funciona localmente, pero los tuneles temporales se caen. Para usarlo con pacientes, subelo a un servicio con URL fija.

## Opcion recomendada: Render

1. Sube este proyecto a GitHub.
2. En Render, crea un `Blueprint` usando `render.yaml` o crea un `Web Service`.
3. Usa:

```text
Build command: npm install
Start command: npm start
Health check path: /health
```

4. Agrega las variables de entorno reales desde tu `.env`. No subas `.env` a GitHub.
5. Cuando Render te de una URL como:

```text
https://whatsapp-calendar-bot.onrender.com
```

configura en Meta Developers:

```text
https://whatsapp-calendar-bot.onrender.com/webhook
```

6. Usa el mismo `WHATSAPP_VERIFY_TOKEN` que configuraste en Render.

## Variables requeridas

```text
WHATSAPP_VERIFY_TOKEN
WHATSAPP_ACCESS_TOKEN
WHATSAPP_PHONE_NUMBER_ID
WHATSAPP_BUSINESS_ACCOUNT_ID
DOCTOR_WHATSAPP_NUMBER
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
GOOGLE_REFRESH_TOKEN
GOOGLE_CALENDAR_ID
AI_PROVIDER
CLINIC_TIMEZONE
CLINIC_NAME
APPOINTMENT_MINUTES
WORK_DAYS
WORK_START
WORK_END
```

## Nota importante

El `GOOGLE_REFRESH_TOKEN` ya existe en tu `.env`; copiandolo a Render no tienes que volver a autorizar Google Calendar.

Si cambias el redirect de Google en el futuro, agrega tambien la URL de produccion en Google Cloud:

```text
https://TU-DOMINIO/oauth/google/callback
```
