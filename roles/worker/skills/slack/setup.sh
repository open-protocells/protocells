#!/bin/sh
BRIDGE_PORT=${BRIDGE_PORT:-3002}
WORKSPACE=${WORKSPACE:-/workspace}
ROUTES_FILE="${WORKSPACE}/routes.json"

node -e "
  var fs = require('fs');
  var routes = {};
  try { routes = JSON.parse(fs.readFileSync('$ROUTES_FILE', 'utf8')); } catch(e) {}
  routes['slack'] = { url: 'http://localhost:$BRIDGE_PORT/reply' };
  fs.writeFileSync('$ROUTES_FILE', JSON.stringify(routes, null, 2));
"

env SLACK_BOT_TOKEN="$SLACK_BOT_TOKEN" SLACK_APP_TOKEN="$SLACK_APP_TOKEN" node "$(dirname "$0")/server.js" --port "$BRIDGE_PORT" --workspace "$WORKSPACE" --agent "http://localhost:${AGENT_PORT:-3000}" &
