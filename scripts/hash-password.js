import crypto from "node:crypto";

const password = process.argv[2];
if (!password || password.length < 16) {
  console.error("Usage: npm run hash:password -- <password-min-16-chars>");
  process.exit(1);
}

console.log(`sha256:${crypto.createHash("sha256").update(password).digest("hex")}`);
