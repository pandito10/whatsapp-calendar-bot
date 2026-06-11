import { requireValues, setEnvValue } from "./env.js";

const code = process.argv[2];
if (!code) {
  console.error("Uso: npm run google:token -- CODIGO_DE_GOOGLE");
  process.exit(1);
}

const env = requireValues(["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]);
const redirectUri =
  env.GOOGLE_REDIRECT_URI ??
  (env.PUBLIC_BASE_URL
    ? `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/oauth/google/callback`
    : "http://localhost:3000/oauth/google/callback");
const response = await fetch("https://oauth2.googleapis.com/token", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    code,
    grant_type: "authorization_code",
    redirect_uri: redirectUri
  })
});

const data = await response.json();
if (!response.ok) {
  console.error(JSON.stringify(data, null, 2));
  process.exit(1);
}

if (!data.refresh_token) {
  console.error("Google no regreso refresh_token. Vuelve a correr google:auth-url y asegúrate de usar prompt=consent.");
  process.exit(1);
}

setEnvValue("GOOGLE_REFRESH_TOKEN", data.refresh_token);
console.log("Listo: GOOGLE_REFRESH_TOKEN guardado en .env");
