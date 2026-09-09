# use the official Bun image
# see all versions at https://hub.docker.com/r/oven/bun/tags
FROM oven/bun:1 AS base
WORKDIR /usr/src/app

RUN echo "Installing dependencies..."

# Install yt-dlp, ffmpeg, python3 and deno.
#
# We use the PyInstaller `yt-dlp_linux*` build rather than the `yt-dlp` zipimport
# binary because only the PyInstaller builds bundle `curl_cffi`, which yt-dlp needs
# for browser impersonation. YouTube's timedtext (subtitle) endpoint is flagged
# `"impersonate": true` by the extractor; without curl_cffi yt-dlp emits
# "no impersonate target is available" and the request is far more likely to be
# rate-limited/bot-checked from a datacenter IP.
# See https://github.com/yt-dlp/yt-dlp/tree/2026.08.19#impersonation
#
# deno >= 2.3.0 is the minimum supported JavaScript runtime for yt-dlp's EJS
# challenge solver (https://github.com/yt-dlp/yt-dlp/wiki/EJS). The previously
# pinned v2.1.4 was below that minimum and would have been rejected as
# unsupported, leaving no usable JS runtime for the `tv`/`web_embedded` fallback
# player clients.
ARG YT_DLP_VERSION=2026.08.19
ARG DENO_VERSION=v2.9.6
RUN apt-get update \
    && for attempt in 1 2 3 4 5; do \
         apt-get install -y --no-install-recommends -o Acquire::Retries=5 \
           ca-certificates curl ffmpeg python3 unzip && break; \
         echo "apt-get install failed (attempt ${attempt}); retrying" >&2; \
         sleep 5; \
       done \
    && command -v curl >/dev/null && command -v ffmpeg >/dev/null && command -v python3 >/dev/null \
    && case "$(dpkg --print-architecture)" in \
         amd64) YT_DLP_ASSET=yt-dlp_linux ;; \
         arm64) YT_DLP_ASSET=yt-dlp_linux_aarch64 ;; \
         *) echo "unsupported architecture: $(dpkg --print-architecture)" >&2; exit 1 ;; \
       esac \
    && curl -fsSL "https://github.com/yt-dlp/yt-dlp/releases/download/${YT_DLP_VERSION}/${YT_DLP_ASSET}" -o /usr/local/bin/yt-dlp \
    && curl -fsSL "https://github.com/yt-dlp/yt-dlp/releases/download/${YT_DLP_VERSION}/SHA2-256SUMS" -o /tmp/SHA2-256SUMS \
    && printf '%s  yt-dlp\n' "$(grep " ${YT_DLP_ASSET}$" /tmp/SHA2-256SUMS | cut -d' ' -f1)" \
       | (cd /usr/local/bin && sha256sum -c -) \
    && rm -f /tmp/SHA2-256SUMS \
    && chmod a+rx /usr/local/bin/yt-dlp \
    && curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh -s ${DENO_VERSION} \
    && /usr/local/bin/yt-dlp --version \
    && /usr/local/bin/deno --version \
    && apt-get purge -y unzip && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

# install dependencies into temp directory
# this will cache them and speed up future builds
FROM base AS install
RUN mkdir -p /temp/dev
COPY container/package.json container/bun.lock /temp/dev/
RUN cd /temp/dev && bun install --frozen-lockfile

# install with --production (exclude devDependencies)
RUN mkdir -p /temp/prod
COPY container/package.json container/bun.lock /temp/prod/
RUN cd /temp/prod && bun install --frozen-lockfile --production

# copy node_modules from temp directory
# then copy all (non-ignored) project files into the image
FROM base AS prerelease
COPY --from=install /temp/dev/node_modules node_modules
COPY container/ .

# copy production dependencies and source code into final image
FROM base AS release
COPY --from=install /temp/prod/node_modules node_modules
COPY --from=prerelease /usr/src/app/src ./src
COPY --from=prerelease /usr/src/app/package.json .

# run the app
USER bun
EXPOSE 3000/tcp
ENTRYPOINT [ "bun", "run", "src/index.ts" ]