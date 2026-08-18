#!/usr/bin/env node

process.env.ACP_ADAPTER = "agy";

import("../dist/index.js")
  .then((m) => m.main("agy"))
  .catch((err) => {
    console.error("Failed to run agy-acp:", err);
    process.exit(1);
  });
