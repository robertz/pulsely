FROM ortussolutions/commandbox:boxlang-ubi9

WORKDIR /app

COPY . .

# lib/ and boxlang_modules/ are gitignored, installed from ForgeBox at build time
RUN box install --production && grep -m1 '"version"' lib/coldbox/box.json

ENV ENVIRONMENT=production \
    BOXLANG_DEBUG=false

# Intentionally no CMD/ENTRYPOINT override: the base image's own run.sh
# starts the server on $PORT (8080 by default) and provides its own
# HEALTHCHECK against http://127.0.0.1:8080/.
