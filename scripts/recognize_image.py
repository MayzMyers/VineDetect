#!/usr/bin/env python3
"""Submit one image to the production V5 recognition endpoint."""

import argparse
import base64
import json
import os
import urllib.error
import urllib.request
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("image", type=Path)
    parser.add_argument("--url", default="http://127.0.0.1:4001/recognize")
    parser.add_argument("--diagnostics", action="store_true")
    args = parser.parse_args()
    raw = args.image.read_bytes()
    if len(raw) > 16 * 1024 * 1024:
        raise SystemExit("Image exceeds the production 16 MiB limit")
    headers = {"content-type": "application/json"}
    if args.diagnostics:
        key = os.environ.get("INTERNAL_API_KEY")
        if not key:
            raise SystemExit("--diagnostics requires INTERNAL_API_KEY")
        headers["x-internal-api-key"] = key
    request = urllib.request.Request(
        args.url,
        headers=headers,
        data=json.dumps(
            {
                "imageBase64": base64.b64encode(raw).decode("ascii"),
                "diagnostics": args.diagnostics,
            }
        ).encode(),
    )
    try:
        with urllib.request.urlopen(request, timeout=300) as response:
            print(json.dumps(json.load(response), ensure_ascii=False, indent=2))
    except urllib.error.HTTPError as error:
        raise SystemExit(f"HTTP {error.code}: {error.read().decode()}") from error


if __name__ == "__main__":
    main()
