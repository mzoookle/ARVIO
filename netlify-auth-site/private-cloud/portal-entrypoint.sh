#!/bin/sh
set -eu

: "${APP_ANON_KEY:?APP_ANON_KEY must be set}"
: "${ARVIO_WEB_ORIGIN:?ARVIO_WEB_ORIGIN must be set}"

envsubst '${APP_ANON_KEY} ${ARVIO_WEB_ORIGIN}' \
  < /usr/share/nginx/html/portal-config.js.template \
  > /usr/share/nginx/html/portal-config.js

exec nginx -g 'daemon off;'
