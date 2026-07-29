FROM ortussolutions/commandbox:boxlang-ubi9

WORKDIR /app

COPY . .

# lib/ and boxlang_modules/ are gitignored, installed from ForgeBox at build time
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

ENV ENVIRONMENT=production \
    BOXLANG_DEBUG=false

# Intentionally no CMD/ENTRYPOINT override: the base image's own run.sh
# starts the server on $PORT (8080 by default) and provides its own
# HEALTHCHECK against http://127.0.0.1:8080/.
