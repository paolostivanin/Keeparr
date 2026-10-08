#!/usr/bin/env node

import { spawn } from "node:child_process"
import { version } from "./package.json" with { type: "json" }

let [major, minor, patch] = version.split(".")
if (patch === undefined) {
  patch = "0"
}

spawn(
  "docker",
  [
    "buildx",
    "build",
    "--platform", "linux/amd64,linux/arm64",
    //"--platform", "linux/amd64",
    "-t", `ghcr.io/paolostivanin/keeparr:${major}.${minor}.${patch}`,
    "-t", `ghcr.io/paolostivanin/keeparr:${major}.${minor}`,
    "-t", `ghcr.io/paolostivanin/keeparr:${major}`,
    "-t", `ghcr.io/paolostivanin/keeparr:latest`,
    "--push",
    ".",
  ],
  {
    stdio: "inherit",
    shell: true,
  },
)
