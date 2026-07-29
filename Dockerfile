FROM ortussolutions/commandbox:boxlang-ubi9

WORKDIR /app

COPY . .

# lib/ and boxlang_modules/ are gitignored, installed from ForgeBox at build time
RUN box install; \
    echo "=== searching for bx-mysql anywhere ==="; grep -rl "bx-mysql" / --include=box.json 2>/dev/null; \
    echo "=== searching filesystem for dir named bx-mysql ==="; ls -la /app /app/* /root/.CommandBox/artifacts 2>&1 | head -80; \
    true

ENV ENVIRONMENT=production \
    BOXLANG_DEBUG=false

# Intentionally no CMD/ENTRYPOINT override: the base image's own run.sh
# starts the server on $PORT (8080 by default) and provides its own
# HEALTHCHECK against http://127.0.0.1:8080/.
