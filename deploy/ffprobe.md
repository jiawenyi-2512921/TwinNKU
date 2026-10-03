# Minimal video probe provenance

The API accepts original MP4/WebM uploads and probes their metadata. It does not
transcode video. The runtime therefore contains a minimal `ffprobe`, rather than
the distro's full FFmpeg package and its XML, GUI, network and encoding libraries.

`api.Dockerfile` builds upstream FFmpeg **9.0.2** from the official release archive,
checks its pinned SHA-256 and verifies its detached GPG signature with the pinned
official release key fingerprint **FCF986EA15E6E293A5644F10B4322F04D67658D8**.
The build scope is file protocol; MOV/MP4 and Matroska/WebM demuxers; H.264, HEVC,
AV1, VP8 and VP9 parsers; and H.264, HEVC, VP8 and VP9 decoders. AV1 metadata is
read through its parser; no external AV1 decoder is installed. No encoder,
network protocol, MPEG-PS demuxer or DVD subtitle parser/decoder is compiled.

The runtime keeps the original source archive, LGPL notice, upstream license,
configuration headers and binary/source hashes in
`/usr/local/share/twinnku/ffprobe`. The Dockerfile supplies the complete rebuild
commands. Upstream source and notices are available at
<https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz>.

Trivy's image gate remains enabled for every HIGH/CRITICAL distro and Python
finding, including unfixed findings. A separate pinned Grype gate reads the
FFmpeg CPE component SBOM, because a source-built C component is not guaranteed
to be identified by Trivy's package scanner. The gate first requires a synthetic
FFmpeg 7.1.5 component to produce a HIGH/CRITICAL finding, so missing CPE coverage
cannot silently produce a green build.

The only VEX assertion is **CVE-2026-6385**, `vulnerable_code_not_present`: the DVD
subtitle fragment parser is excluded from the actual build. Generation and
runtime verification fail unless the three relevant disabled flags are present.
The version/source-specific assertion is shown in the scan's suppressed results.
It does not exempt other FFmpeg, system or Python vulnerabilities. The issue and
affected component are documented by the official Debian tracker:
<https://security-tracker.debian.org/tracker/CVE-2026-6385>.

When updating the source or base, recheck the official signing key and archive,
update the component inventory and scan canary, and repeat actual MP4/WebM
uploads plus Linux integration tests against the final runtime image. A clean
package scan alone does not demonstrate media compatibility or prove the
absence of unknown vulnerabilities.
