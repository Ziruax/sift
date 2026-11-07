#!/usr/bin/env bash
# Prepare the Netlify deploy copy of Sift.
#
# Builds happen HERE (in the sandbox) — `netlify deploy --build` then uploads
# the finished output, so the hosting account's build minutes are never
# spent. The copy excludes everything the deployed app doesn't need.
set -euo pipefail

SRC=/home/z/my-project
DEST=/home/z/deploy/sift

rm -rf "$DEST"
mkdir -p "$DEST"

rsync -a \
  --exclude node_modules \
  --exclude .next \
  --exclude dev.log \
  --exclude server.log \
  --exclude sift-orig \
  --exclude tool-results \
  --exclude tests \
  --exclude skills \
  --exclude download \
  --exclude upload \
  --exclude examples \
  --exclude mini-services \
  --exclude agent-ctx \
  --exclude .git \
  --exclude .netlify \
  "$SRC"/ "$DEST"/

# ── Deploy-specific adjustments ──────────────────────────────────────────────

# 1. next.config: no standalone output (Netlify's Next runtime manages the
#    output itself). Next 16 no longer lints during builds.
cat > "$DEST/next.config.ts" <<'EOF'
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  devIndicators: false,
};

export default nextConfig;
EOF

# 2. package.json: plain next build (no standalone copy steps), plus the
#    Netlify CLI + Next runtime as dev dependencies so `netlify deploy
#    --build` finds them.
node -e '
const fs = require("fs");
const path = "'"$DEST"'/package.json";
const pkg = JSON.parse(fs.readFileSync(path, "utf8"));
pkg.name = "sift";
pkg.scripts.build = "next build";
pkg.scripts.start = "next start";
pkg.devDependencies = { ...(pkg.devDependencies ?? {}), "netlify-cli": "^27.0.0", "@netlify/plugin-nextjs": "^5.0.0" };
fs.writeFileSync(path, JSON.stringify(pkg, null, 2) + "\n");
'

# 3. netlify.toml — the Next.js runtime plugin, Node 22, and the SQLite file
#    bundled into functions (writes are ephemeral per function instance; the
#    app is client-first so this is best-effort).
cat > "$DEST/netlify.toml" <<'EOF'
[build]
  command = "npm run build"
  publish = ".next"

[build.environment]
  NODE_VERSION = "22"
  DATABASE_URL = "file:./db/custom.db"
  NEXT_TELEMETRY_DISABLED = "1"

[[plugins]]
  package = "@netlify/plugin-nextjs"

[functions]
  included_files = ["db/custom.db"]
EOF

echo "Deploy copy ready at $DEST"
