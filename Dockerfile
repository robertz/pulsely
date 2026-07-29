FROM ortussolutions/commandbox:boxlang-ubi9

WORKDIR /app

COPY . .

# lib/ and boxlang_modules/ are gitignored, installed from ForgeBox at build time
RUN box install --production

ENV BOX_SERVER_WEB_HOST=0.0.0.0 \
    BOX_SERVER_WEB_HTTP_PORT=8080 \
    BOX_SERVER_APP_CFENGINE=boxlang@1 \
    ENVIRONMENT=production \
    BOXLANG_DEBUG=false

EXPOSE 8080

CMD ["box", "server", "start", "--console", "port=8080", "host=0.0.0.0"]
