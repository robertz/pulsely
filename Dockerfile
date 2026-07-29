FROM ortussolutions/commandbox:boxlang-ubi9

WORKDIR /app

COPY . .

# lib/ and boxlang_modules/ are gitignored and excluded by .dockerignore,
# so they can only come from ForgeBox at build time.
RUN box install --production

# ColdBox's LoaderService.createDefaultLogBox() unconditionally bootstraps
# using coldbox.system.web.config.LogBox, before any app-level LogBox
# config is ever consulted. That vendored default registers the console
# appender by its short class name ("ConsoleAppender"), which Adobe/Lucee
# resolve via an implicit search path - BoxLang's class resolver doesn't,
# so it throws ClassNotFoundBoxLangException on every boot. Patch the
# vendored file post-install since it's reinstalled fresh on every build.
RUN sed -i 's/class : "ConsoleAppender"/class : "coldbox.system.logging.appenders.ConsoleAppender"/' \
    lib/coldbox/system/web/config/LogBox.cfc

# server.json binds HTTP to 8085 for local dev; DigitalOcean routes to and
# health-checks 8080. CommandBox honors box_server_* env vars as server.json
# overrides, so prod moves without changing the local binding.
ENV BOX_SERVER_WEB_HTTP_PORT=8080

ENV ENVIRONMENT=production \
    BOXLANG_DEBUG=false \
    BOX_SERVER_APP_CFENGINE=boxlang@1.15

EXPOSE 8080

# Intentionally no CMD/ENTRYPOINT override: the base image's own run.sh
# starts the server and provides its own HEALTHCHECK against
# http://127.0.0.1:8080/.
