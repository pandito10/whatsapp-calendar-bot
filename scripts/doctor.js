import { checkDatabaseHealth } from "../src/db.js";
import { buildOperationalHealth, isOperationallyUnhealthy } from "../src/health.js";

const db = await checkDatabaseHealth();
const health = buildOperationalHealth({ db });
console.log(JSON.stringify(health, null, 2));

if (isOperationallyUnhealthy(health) || health.readiness?.status !== "ready") {
  console.error("\nRobot is not production-ready yet. Fix the listed problems/readiness checks before using it with real patients.");
  process.exit(1);
}

console.log("\nRobot readiness looks good for the configured environment.");
