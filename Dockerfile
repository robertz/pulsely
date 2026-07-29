FROM ortussolutions/commandbox:boxlang-ubi9

WORKDIR /app

COPY runtime/boxlang.json .

ENV ENVIRONMENT=production \
    BOXLANG_DEBUG=false \
    BOX_SERVER_APP_CFENGINE=boxlang@1.15
