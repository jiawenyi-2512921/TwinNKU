"""A small, bounded plain-text WebVTT subset; never execute markup or cue CSS.

Original UTF-8 bytes are retained. Cue settings, STYLE/REGION/NOTE blocks and
markup are rejected rather than silently changed. Teams provide actual captions.
"""

import hashlib
import re
import unicodedata

MAX_CAPTION_BYTES = 1024 * 1024
MAX_CUES = 10000
MAX_TIME_MS = 12 * 60 * 60 * 1000
_TIMING = re.compile(r"^(?:(\d{2}):)?([0-5]\d):([0-5]\d)\.(\d{3})$")
_IDENTIFIER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$")


def timestamp(value):
    match = _TIMING.fullmatch(value)
    if not match:
        raise ValueError("invalid caption timestamp")
    hours, minutes, seconds, millis = match.groups()
    total = ((int(hours or 0) * 60 + int(minutes)) * 60 + int(seconds)) * 1000 + int(millis)
    if total > MAX_TIME_MS:
        raise ValueError("caption time limit")
    return total


def inspect_captions(raw):
    if not 0 < len(raw) <= MAX_CAPTION_BYTES:
        raise ValueError("caption byte limit")
    text = raw.decode("utf-8-sig", errors="strict")
    if (
        any(unicodedata.category(c) in {"Cc", "Cf"} and c not in "\r\n\t" for c in text)
        or "<" in text
    ):
        raise ValueError("caption markup or control characters")
    # Browser VTT parsing is line based. Bare CR and CRLF have identical meaning.
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    blocks = re.split(r"\n[ \t]*\n", text.rstrip("\n"))
    if not blocks or blocks[0] != "WEBVTT" or not 1 <= len(blocks) - 1 <= MAX_CUES:
        raise ValueError("caption header or cue count")
    previous_start = -1
    end_time = 0
    identifiers = set()
    for block in blocks[1:]:
        lines = block.split("\n")
        if " --> " not in lines[0]:
            identifier = lines.pop(0)
            if (
                not _IDENTIFIER.fullmatch(identifier)
                or identifier in identifiers
                or identifier in {"NOTE", "STYLE", "REGION"}
            ):
                raise ValueError("invalid caption cue identifier")
            identifiers.add(identifier)
        if not 2 <= len(lines) <= 9 or lines[0].count(" --> ") != 1:
            raise ValueError("caption cue structure")
        start_text, end_text = lines[0].split(" --> ")
        start, end = timestamp(start_text), timestamp(end_text)
        if start < previous_start or end <= start or end - start > 10 * 60 * 1000:
            raise ValueError("caption cue timing")
        payload = lines[1:]
        if not any(line.strip() for line in payload) or any(
            len(line) > 2000 or any(c in line for c in "<>") for line in payload
        ):
            raise ValueError("caption cue text")
        previous_start = start
        end_time = max(end_time, end)
    return {
        "sha256": hashlib.sha256(raw).hexdigest(),
        "size_bytes": len(raw),
        "cue_count": len(blocks) - 1,
        "duration_seconds": end_time / 1000,
    }
