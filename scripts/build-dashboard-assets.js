#!/usr/bin/env node
import { buildDashboardAssets } from "./dashboard-assets.js";

const dependencyRoot = process.env.ANT_CODE_DASHBOARD_ASSET_DEPENDENCY_ROOT;
const result = await buildDashboardAssets({ dependencyRoot });
console.log(`Dashboard rich rendering assets built (${result.fileCount} files).`);
