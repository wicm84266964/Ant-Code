#!/usr/bin/env node
import { verifyDashboardAssets } from "./dashboard-assets.js";

try {
  const dependencyRoot = process.env.ANT_CODE_DASHBOARD_ASSET_DEPENDENCY_ROOT;
  const result = await verifyDashboardAssets({ dependencyRoot });
  console.log(`Dashboard asset check passed (${result.fileCount} files matched byte-for-byte).`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
