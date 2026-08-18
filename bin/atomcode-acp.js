#!/usr/bin/env node

process.env.ACP_ADAPTER = "atomcode";

import("../dist/index.js")
  .then((m) => m.main("atomcode"))
  .catch((err) => {
    console.error("Failed to run atomcode-acp:", err);
    process.exit(1);
  });
