#!/usr/bin/env bash
cd "$(dirname "$0")" || exit 1
command -v node >/dev/null || { echo "Node.js 20 or newer is required: https://nodejs.org"; exit 1; }
exec node server/launch.js
