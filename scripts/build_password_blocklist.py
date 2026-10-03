"""Reproduce the bundled blocklist from a verified LOCAL upstream snapshot.

No network calls. The input remains outside Git; only sorted SHA-256 hashes,
coverage metadata and the upstream license are written into the API artifact.
Changing source versions requires deliberate review of the pinned checksums.
"""

import argparse
import hashlib
import json
import stat
from pathlib import Path

SOURCE_SHA256 = "424a3e03a17df0a2bc2b3ca749d81b04e79d59cb7aeec8876a5a3f308d0caf51"
LICENSE_SHA256 = "3dbdc93d5f8829de0941744841730a09c106d0732e5ae0e98ca1d77be7ded66c"
ROOT = Path(__file__).resolve().parents[1]


def checked_input(path, maximum, checksum):
    details = path.stat()
    if path.is_symlink() or not stat.S_ISREG(details.st_mode) or details.st_size > maximum:
        raise ValueError("Source must be a bounded regular file")
    raw = path.read_bytes()
    if hashlib.sha256(raw).hexdigest() != checksum:
        raise ValueError("Local upstream snapshot does not match the reviewed version")
    return raw


def derive(raw):
    common, breached, all_compatible = [], [], set()
    for line in raw.splitlines():
        try:
            word = line.decode("utf-8")
        except UnicodeDecodeError:
            continue
        if not word.strip() or len(word) > 128:
            continue
        if len(breached) < 10000:
            breached.append(word)
        if 12 <= len(word) <= 128:
            if word not in all_compatible and len(common) < 3000:
                common.append(word)
            all_compatible.add(word)
    if len(common) != 3000 or len(breached) != 10000:
        raise ValueError("Source cannot cover 3000 policy-compatible common passwords")
    values = {
        hashlib.sha256(value.encode("utf-8")).hexdigest()
        for word in common + breached
        for value in {word, word.casefold()}
    }
    return ("\n".join(sorted(values)) + "\n").encode("ascii"), {
        "matching_policy_unique": len(common),
        "source_matching_policy_unique": len(all_compatible),
        "breached_sample_candidates": len(breached),
        "artifact_hash_count": len(values),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-file", type=Path, required=True)
    parser.add_argument("--license-file", type=Path, required=True)
    args = parser.parse_args()
    raw = checked_input(args.source_file, 12_000_000, SOURCE_SHA256)
    license_raw = checked_input(args.license_file, 4096, LICENSE_SHA256)
    artifact, coverage = derive(raw)
    target = ROOT / "apps/api/app/data"
    metadata_path = target / "password_blocklist.json"
    # Preserve audited provenance; regeneration cannot silently invent sources.
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    if metadata["source_sha256"] != SOURCE_SHA256 or metadata["license_sha256"] != LICENSE_SHA256:
        raise ValueError("Provenance version differs")
    metadata.update(
        **coverage,
        artifact_sha256=hashlib.sha256(artifact).hexdigest(),
        artifact_bytes=len(artifact),
    )
    (target / "password_blocklist.sha256").write_bytes(artifact)
    (target / "SecLists.LICENSE").write_bytes(license_raw)
    metadata_path.write_text(
        json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(
        "Verified local blocklist generated: "
        f"{coverage['matching_policy_unique']} compatible entries; "
        f"{coverage['artifact_hash_count']} hashes"
    )


if __name__ == "__main__":
    main()
