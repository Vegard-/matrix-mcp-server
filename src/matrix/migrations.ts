import path from "path";
import { existsSync, readFileSync, writeFileSync, readdirSync, unlinkSync, rmSync } from "fs";

interface Migration {
  version: number;
  name: string;
  migrate: (dataDir: string) => void;
}

const migrations: Migration[] = [
  {
    version: 1,
    name: "reset-crypto-store-for-cross-signing-fix",
    migrate: (dataDir) => {
      // The old code ran bootstrapCrossSigning unconditionally, which reset the
      // user's cross-signing identity on every boot. This broke E2EE trust with
      // other devices (Element, etc.) and caused "sender has not sent us the keys"
      // errors. The new code checks cross-signing status first.
      //
      // To recover, we must delete the corrupted crypto store so the new code
      // can bootstrap cleanly against the server's current cross-signing state.

      // Delete SSSS recovery key (will be regenerated)
      const recoveryKeyFile = path.join(dataDir, "ssss-recovery-key");
      if (existsSync(recoveryKeyFile)) {
        unlinkSync(recoveryKeyFile);
        console.error("[Migration v1] Deleted ssss-recovery-key");
      }

      // Delete all IndexedDB SQLite files (crypto store)
      // These are named like: matrix-sdk-crypto-<prefix>.sqlite and idb-* files
      try {
        const files = readdirSync(dataDir);
        for (const file of files) {
          if (
            file.includes("matrix-sdk-crypto") ||
            file.includes("matrix-js-sdk") ||
            file.startsWith("idb-")
          ) {
            const filePath = path.join(dataDir, file);
            rmSync(filePath, { force: true, recursive: true });
            console.error(`[Migration v1] Deleted ${file}`);
          }
        }
      } catch (e: any) {
        console.warn("[Migration v1] Error cleaning crypto files:", e.message);
      }

      console.error("[Migration v1] Crypto store reset complete. Next boot will establish clean cross-signing.");
    },
  },
];

export const CURRENT_DATA_VERSION = migrations.length;

export function runMigrations(dataDir: string): void {
  const versionFile = path.join(dataDir, "data-version");
  let currentVersion = 0;

  if (existsSync(versionFile)) {
    const raw = readFileSync(versionFile, "utf-8").trim();
    currentVersion = parseInt(raw, 10) || 0;
  }

  if (currentVersion >= CURRENT_DATA_VERSION) {
    return; // Already up to date
  }

  console.error(`[Migrations] Data version ${currentVersion} → ${CURRENT_DATA_VERSION}`);

  for (const migration of migrations) {
    if (migration.version > currentVersion) {
      console.error(`[Migrations] Running v${migration.version}: ${migration.name}`);
      try {
        migration.migrate(dataDir);
      } catch (e: any) {
        console.error(`[Migrations] v${migration.version} failed: ${e.message}`);
        // Write the version we got to so we don't re-run successful ones
        writeFileSync(versionFile, String(migration.version - 1), "utf-8");
        throw e;
      }
    }
  }

  writeFileSync(versionFile, String(CURRENT_DATA_VERSION), "utf-8");
  console.error(`[Migrations] Complete. Data version is now ${CURRENT_DATA_VERSION}`);
}
