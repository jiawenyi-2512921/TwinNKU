FROM postgres:17-alpine@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24

# The official entrypoint only invokes gosu when started as UID 0. Its PGDATA
# directory is already owned by postgres (UID/GID 70), including new volumes.
# Keep the original PostgreSQL binaries, data layout and entrypoint, and start
# directly as that user instead of retaining the unused Go privilege helper.
RUN rm /usr/local/bin/gosu && test ! -e /usr/local/bin/gosu
USER postgres
