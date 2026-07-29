FROM ortussolutions/commandbox:boxlang-ubi9

WORKDIR /app

COPY . .

# lib/ and boxlang_modules/ are gitignored, installed from ForgeBox at build time
RUN box install --production; \
    echo "=== boxlang_modules ==="; ls -la boxlang_modules 2>&1; \
    echo "=== lib/modules ==="; ls -la lib/modules 2>&1; \
    echo "=== lib ==="; ls -la lib 2>&1; \
    find . -maxdepth 4 -name box.json -not -path "./box.json" -exec sh -c 'echo -n "{} "; grep -m1 version {}' \; 2>&1; \
    true

ENV ENVIRONMENT=production \
    BOXLANG_DEBUG=false

# Intentionally no CMD/ENTRYPOINT override: the base image's own run.sh
# starts the server on $PORT (8080 by default) and provides its own
# HEALTHCHECK against http://127.0.0.1:8080/.
