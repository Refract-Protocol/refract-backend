import { execSync } from "child_process";
import * as fs from "fs";

const CONTAINER_ID_FILE = "/tmp/refract-test-pg-container-id";

/**
 * Jest globalTeardown — runs once after all test workers finish.
 * Stops the Docker container started by global-setup (if any).
 */
export default async function globalTeardown(): Promise<void> {
  if (!fs.existsSync(CONTAINER_ID_FILE)) {
    // Pre-provisioned DB (CI): nothing to tear down.
    return;
  }
  const containerId = fs.readFileSync(CONTAINER_ID_FILE, "utf8").trim();
  try {
    execSync(`docker stop ${containerId}`, { stdio: "ignore" });
    console.log("[integration] Stopped Postgres container", containerId);
  } catch {
    // Container may have already exited — not an error.
  } finally {
    fs.unlinkSync(CONTAINER_ID_FILE);
  }
}
