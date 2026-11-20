FROM nginx:alpine
RUN apk add --no-cache gettext
COPY index.html admin.html delete-account.html oidc-callback.html account-security.html /usr/share/nginx/html/
COPY assets/ /usr/share/nginx/html/assets/
COPY discord/ /usr/share/nginx/html/discord/
COPY private-cloud/nginx-portal.conf /etc/nginx/conf.d/default.conf
COPY private-cloud/portal-config.js.template /usr/share/nginx/html/portal-config.js.template
COPY private-cloud/portal-entrypoint.sh /usr/local/bin/portal-entrypoint.sh
RUN chmod 0755 /usr/local/bin/portal-entrypoint.sh
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/portal-entrypoint.sh"]
