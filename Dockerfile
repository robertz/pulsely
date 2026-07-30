FROM ortussolutions/commandbox:boxlang-ubi9

# The base image sets APP_DIR=/app and WORKDIR /app. That collides with the
# BoxLang mapping named "/app" in runtime/boxlang.json, whose target is
# "${user-dir}/app" - and ${user-dir} is the working directory. When the
# working directory is literally /app, a real on-disk /app competes with the
# mapping of the same name and path resolution doubles a segment, so ColdBox
# looks for /app/app/app/config/Coldbox.bx. Locally ${user-dir} is the project
# path, so the two never collide. Relocate so the container matches local.
ENV APP_DIR=/srv/pulsely
WORKDIR $APP_DIR

# The base image bakes a sample app into /app. Remove it so no real directory
# shadows the "/app" mapping.
RUN rm -rf /app

COPY . .

# The bx-* BoxLang modules are installed by the commandbox-boxlang CommandBox
# module, which lives in devDependencies and is therefore skipped by
# --production. Without it CommandBox reports "Installing package
# [forgebox:bx-mysql] √" and silently places nothing, leaving
# boxlang_modules/ empty and the runtime with 0 activated modules. Install it
# into CommandBox itself first so the bx-* dependencies actually land.
RUN box install commandbox-boxlang --system

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

# Pin the exact build. "boxlang@1.15" is not a build coordinate, so CommandBox
# has to ask ForgeBox which build satisfies it and then download an engine the
# image was not warmed for. On App Platform that stalled past the readiness
# probe with no output at all. 1.15.0+52 is the exact current 1.15 build.
ENV ENVIRONMENT=production \
    BOXLANG_DEBUG=false \
    BOX_SERVER_APP_CFENGINE=boxlang@1.15.0+52

# Production class caching. Defaults in boxlang.json are the dev-friendly
# values; set before the warmup so classes compiled during the build survive
# into the container instead of being wiped and recompiled on first request.
# trustedCache never re-stats a template, which is correct for an immutable
# image but would hide edits if anything ever wrote templates at runtime.
ENV BOXLANG_CLEAR_CLASSES=false \
    BOXLANG_TRUSTED_CACHE=true

# The base image ships a serverHome with boxlang@1.7.0+43 already deployed.
# Asking for any other engine makes CommandBox refuse to redeploy over it
# ("this server home already has [boxlang@1.7.0+43] deployed to it") and it
# quietly keeps 1.7.0. Clear it so the warmup below deploys 1.15.0+52 cleanly.
RUN rm -rf /usr/local/lib/serverHome

# Warm the server at build time so the engine is unpacked into the image
# rather than downloaded on every container start. Without this, App Platform
# stalled past the readiness probe with no output while resolving the engine.
RUN ${BUILD_DIR}/util/warmup-server.sh

# Seed the finalized startup script. Without this, every container start spends
# ~4m36s in "Generating server startup script" - CommandBox is itself a CFML
# app, so `box server start` boots a full Lucee JVM just to resolve config and
# emit a shell script, and it redoes that on every boot. With FINALIZE_STARTUP
# set, start-server.sh writes the result to startup-final.sh, which run.sh then
# uses authoritatively and skips CommandBox entirely. Runwar bound 3s after
# handoff, so this is nearly all of the startup cost.
RUN FINALIZE_STARTUP=true ${BUILD_DIR}/run.sh

EXPOSE 8080

# Intentionally no CMD/ENTRYPOINT override: the base image's own run.sh
# starts the server and provides its own HEALTHCHECK against
# http://127.0.0.1:8080/.
