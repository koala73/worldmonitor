#!/bin/sh
export LOCAL_API_PORT="${LOCAL_API_PORT:-46123}"
envsubst '$LOCAL_API_PORT' < /etc/nginx/nginx.conf.template > /etc/nginx/nginx.conf
exec /usr/bin/supervisord -c /etc/supervisor/conf.d/worldmonitor.conf
