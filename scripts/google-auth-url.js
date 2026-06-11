import { requireValues } from "./env.js";

const env = requireValues(["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]);
const redirectUri =
  env.GOOGLE_REDIRECT_URI ??
  (env.PUBLIC_BASE_URL
    ? `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/oauth/google/callback`
    : "http://localhost:3000/oauth/google/callback");

const params = new URLSearchParams({
  client_id: env.GOOGLE_CLIENT_ID,
  redirect_uri: redirectUri,
  response_type: "code",
  access_type: "offline",
  prompt: "consent",
  scope: "https://www.googleapis.com/auth/calendar"
});

console.log("Abre este enlace con la cuenta de Google Calendar de la doctora:");
console.log(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
console.log("");
console.log("Despues de autorizar, copia el valor de 'code' de la URL y corre:");
console.log("npm run google:token -- CODIGO_AQUI");
