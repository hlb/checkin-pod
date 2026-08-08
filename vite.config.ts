import vinext from "vinext";
import { disableTypes } from "image-size";
import { defineConfig, loadEnv } from "vite";
import hostingConfig from "./.openai/hosting.json" with { type: "json" };
import { sites } from "./build/sites-vite-plugin.ts";

// image-size 2.0.2 has no patched release for infinite-loop parsers.
// The application accepts JPG, PNG, and WebP, so disable the affected formats globally.
disableTypes(["heif", "icns", "jxl", "jxl-stream"]);

const SITE_CREATOR_PLACEHOLDER_DATABASE_ID =
  "00000000-0000-4000-8000-000000000000";

const { d1, r2 } = hostingConfig;

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";

export default defineConfig(async ({ mode }) => {
  const localEnv = loadEnv(mode, process.cwd(), "");
  const adminPassword = process.env.ADMIN_PASSWORD ?? localEnv.ADMIN_PASSWORD;
  const adminUsername = process.env.ADMIN_USERNAME ?? localEnv.ADMIN_USERNAME;
  const adminUsersJson = process.env.ADMIN_USERS_JSON ?? localEnv.ADMIN_USERS_JSON;
  const sessionSecret = process.env.SESSION_SECRET ?? localEnv.SESSION_SECRET;
  const localBindingConfig = {
    main: "./worker/index.ts",
    compatibility_flags: ["nodejs_compat"],
    triggers: { crons: ["17 3 * * *"] },
    d1_databases: d1
      ? [
          {
            binding: d1,
            database_name: "site-creator-d1",
            database_id: SITE_CREATOR_PLACEHOLDER_DATABASE_ID,
          },
        ]
      : [],
    r2_buckets: r2
      ? [
          {
            binding: r2,
            bucket_name: "site-creator-r2",
          },
        ]
      : [],
    ratelimits: [
      { name: "LOGIN_RATE_LIMITER", namespace_id: "41001", simple: { limit: 10, period: 60 as const } },
      { name: "SCAN_RATE_LIMITER", namespace_id: "41002", simple: { limit: 900, period: 60 as const } },
      { name: "UNKNOWN_SCAN_RATE_LIMITER", namespace_id: "41003", simple: { limit: 60, period: 60 as const } },
      { name: "SCAN_IP_RATE_LIMITER", namespace_id: "41004", simple: { limit: 60_000, period: 60 as const } },
      { name: "UNKNOWN_SCAN_IP_RATE_LIMITER", namespace_id: "41005", simple: { limit: 3_000, period: 60 as const } },
    ],
    ...(mode === "development"
      ? {
          vars: {
            ...(adminPassword ? { ADMIN_PASSWORD: adminPassword } : {}),
            ...(adminUsername ? { ADMIN_USERNAME: adminUsername } : {}),
            ...(adminUsersJson ? { ADMIN_USERS_JSON: adminUsersJson } : {}),
            ...(sessionSecret ? { SESSION_SECRET: sessionSecret } : {}),
          },
        }
      : {}),
  };

  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import("@cloudflare/vite-plugin");

  return {
    server: isCodexSeatbeltSandbox
      ? { watch: { useFsEvents: false, usePolling: true } }
      : undefined,
    plugins: [
      vinext(),
      sites(),
      cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        config: localBindingConfig,
        persistState: process.env.CHECKIN_POD_PERSIST_PATH
          ? { path: process.env.CHECKIN_POD_PERSIST_PATH }
          : true,
      }),
    ],
  };
});
