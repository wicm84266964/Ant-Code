import { execFile } from "node:child_process";
import process from "node:process";
import type { GitStatusSummary } from "./types.ts";

export function readGitStatusSummary(cwd: string, env?: NodeJS.ProcessEnv): Promise<GitStatusSummary> {
  return new Promise((resolve) => {
    execFile("git", ["status", "--short"], {
      cwd,
      env: env ?? process.env,
      windowsHide: true,
      timeout: 5000,
      encoding: "utf8"
    }, (error, stdout, stderr) => {
      if (error) {
        resolve({
          gitAvailable: false,
          gitStatus: String(stderr || error.message || "git status unavailable").trim()
        });
        return;
      }
      resolve({
        gitAvailable: true,
        gitStatus: String(stdout).trim() || "clean"
      });
    });
  });
}
