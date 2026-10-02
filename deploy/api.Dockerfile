FROM python:3.12.15-alpine3.24@sha256:8a001d79e5a57ae4de7faa57af12f3d589058ea06ac42ec850c1cb0ac325bd21 AS probe-build
# The stable distro FFmpeg packages still contain deferred parser vulnerabilities.
# Build only our file/MP4/WebM probe from the signed upstream release; no network,
# DVD subtitle parser, encoding, device, XML, GUI or external codec dependencies.
RUN apk add --no-cache build-base curl gnupg xz
WORKDIR /build
RUN curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --max-time 120 https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz -o source.tar.xz \
    && curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --max-time 60 https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz.asc -o source.tar.xz.asc \
    && curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --max-time 60 https://ffmpeg.org/ffmpeg-devel.asc -o release-key.asc \
    && printf '%s  source.tar.xz\n' 8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e | sha256sum -c \
    && printf '%s  release-key.asc\n' 397b3becedcd5a98769967ff1ff8501ddc89f8368b8f766e4701377d7dbaabe5 | sha256sum -c \
    && gpg --batch --import release-key.asc \
    && gpg --batch --status-fd 1 --verify source.tar.xz.asc source.tar.xz > signature-status \
    && grep -q '^\[GNUPG:\] VALIDSIG FCF986EA15E6E293A5644F10B4322F04D67658D8 ' signature-status \
    && tar -xJf source.tar.xz \
    && cd ffmpeg-9.0.2 \
    && ./configure --disable-everything --disable-autodetect --disable-network \
       --disable-programs --enable-ffprobe --disable-doc --disable-debug --disable-x86asm \
       --disable-avdevice --disable-avfilter --disable-swscale --disable-swresample \
       --disable-shared --enable-static --enable-protocol=file \
       --enable-demuxer=mov,matroska --enable-parser=h264,hevc,av1,vp8,vp9 \
       --enable-decoder=h264,hevc,vp8,vp9 \
    && make -j2 ffprobe \
    && mkdir -p /out \
    && cp ffprobe config.h config_components.h COPYING.LGPLv2.1 LICENSE.md README.md /out/ \
    && cp /build/source.tar.xz /out/ffmpeg-9.0.2.tar.xz
COPY scripts/verify_ffprobe.py /build/verify_ffprobe.py
RUN python /build/verify_ffprobe.py build /out

FROM python:3.12.15-alpine3.24@sha256:8a001d79e5a57ae4de7faa57af12f3d589058ea06ac42ec850c1cb0ac325bd21
COPY --from=ghcr.io/astral-sh/uv:0.12.17@sha256:10787c682e4184e4f290de1171fd4703dc63de99221f10fe1c99002ce7fa9acc /uv /usr/local/bin/uv
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 UV_COMPILE_BYTECODE=1
WORKDIR /app
RUN apk upgrade --no-cache
COPY --from=probe-build /out/ffprobe /usr/local/bin/ffprobe
COPY --from=probe-build /out/ /usr/local/share/twinnku/ffprobe/
COPY apps/api/pyproject.toml apps/api/uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY apps/api/app ./app
COPY apps/api/migrations ./migrations
COPY apps/api/alembic.ini ./
RUN addgroup -S -g 10001 twinnku && adduser -S -D -u 10001 -G twinnku twinnku \
    && mkdir -p /data/maps /data/floors && chown twinnku:twinnku /data/maps /data/floors
ENV PATH="/app/.venv/bin:$PATH"
USER 10001
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--no-access-log"]
