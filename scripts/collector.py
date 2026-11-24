"""Locate the test Collector or install the pinned upstream binary in the build cache."""
import hashlib
import os
import platform
import shutil
import tarfile
import tempfile
import urllib.request
from pathlib import Path

VERSION = "0.165.0"
DIGESTS = {
    "darwin_amd64": "3abe452b96764b126cb43b1440e0f8e02903ee02c48a4e7f2584d740bf6ff71b",
    "darwin_arm64": "1d68c0f41011a571199cd9489b04dd554e12091cacba862803a5c8ef0004d32a",
    "linux_amd64": "78570dd4bd6570bc41eb327869ef913bbf91b87dd8170ebebbf43bec71f6370d",
    "linux_arm64": "e59c320b90885610e346f3f82d2ceca55c5c30ede1549fd14cce577d175901cd",
}


def collector():
    if supplied := os.getenv("OTELCOL_BIN"):
        return Path(supplied).resolve(strict=True)
    arch = {"aarch64": "arm64", "x86_64": "amd64"}.get(platform.machine(), platform.machine())
    target = f"{platform.system().lower()}_{arch}"
    if target not in DIGESTS:
        raise SystemExit("Set OTELCOL_BIN to an installed core Collector binary on this platform.")
    cache = Path(".cache/otelcol").resolve() / VERSION / target
    cache.mkdir(parents=True, exist_ok=True)
    binary = cache / "otelcol"
    if binary.is_file():
        return binary
    name = f"otelcol_{VERSION}_{target}.tar.gz"
    url = f"https://github.com/open-telemetry/opentelemetry-collector-releases/releases/download/v{VERSION}/{name}"
    with tempfile.TemporaryDirectory(dir=cache) as directory:
        archive = Path(directory) / name
        with urllib.request.urlopen(url, timeout=120) as response, archive.open("wb") as out:
            shutil.copyfileobj(response, out)
        with archive.open("rb") as stream:
            digest = hashlib.sha256()
            for block in iter(lambda: stream.read(1 << 20), b""):
                digest.update(block)
        if digest.hexdigest() != DIGESTS[target]:
            raise ValueError("Collector archive checksum mismatch")
        staged = Path(directory) / "otelcol"
        with tarfile.open(archive) as bundle, staged.open("wb") as out:
            member = bundle.getmember("otelcol")
            if not member.isfile():
                raise ValueError("Expected a regular binary")
            with bundle.extractfile(member) as stream:
                shutil.copyfileobj(stream, out)
        staged.chmod(0o755)
        staged.replace(binary)
    return binary


if __name__ == "__main__":
    print(collector())
