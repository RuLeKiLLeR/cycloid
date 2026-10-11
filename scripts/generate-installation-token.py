#!/usr/bin/env python3
"""Generate a scoped GitHub App installation token.

Reads GH_APP_ID and GH_APP_PRIVATE_KEY from the environment, mints a JWT,
finds the installation for the target org, and requests a scoped token.
Prints only the token to stdout; diagnostics go to stderr.
"""

import json
import os
import sys
import time
import urllib.request

import jwt  # PyJWT

# Keep the requested installation scope aligned with the repos Cycloid needs.
TARGET_ORG = "trycycloid"
TARGET_REPOS = ["cycloid"]

GITHUB_API = "https://api.github.com"


def die(msg: str) -> None:
    print(msg, file=sys.stderr)
    sys.exit(1)


def create_jwt(app_id: str, private_key_pem: str) -> str:
    """Create a JWT for GitHub App authentication."""
    now = int(time.time())
    payload = {
        "iss": app_id,
        "iat": now - 60,  # clock skew tolerance
        "exp": now + 600,  # GitHub max is 10 minutes
    }
    return jwt.encode(payload, private_key_pem, algorithm="RS256")


def find_installation(jwt_token: str) -> int:
    """Find the installation ID for TARGET_ORG by paginating /app/installations."""
    url = f"{GITHUB_API}/app/installations?per_page=100"
    while url:
        req = urllib.request.Request(
            url,
            headers={
                "Authorization": f"Bearer {jwt_token}",
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
            },
        )
        try:
            with urllib.request.urlopen(req) as resp:
                installations = json.loads(resp.read())
                for inst in installations:
                    if inst.get("account", {}).get("login") == TARGET_ORG:
                        return inst["id"]
                # Check for next page via Link header
                link = resp.headers.get("Link", "")
                url = None
                for part in link.split(","):
                    if 'rel="next"' in part:
                        url = part.split(";")[0].strip().strip("<>")
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", errors="replace")
            die(f"GitHub API error listing installations: {e.code} {e.reason}\n{body}")
    die(f"No installation found for org '{TARGET_ORG}'")
    return 0  # unreachable, satisfies type checker


def create_installation_token(jwt_token: str, installation_id: int) -> str:
    """Request a scoped installation token for TARGET_REPOS."""
    url = f"{GITHUB_API}/app/installations/{installation_id}/access_tokens"
    body = json.dumps({"repositories": TARGET_REPOS}).encode()
    req = urllib.request.Request(
        url,
        method="POST",
        headers={
            "Authorization": f"Bearer {jwt_token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "Content-Type": "application/json",
        },
        data=body,
    )
    try:
        with urllib.request.urlopen(req) as resp:
            data = json.loads(resp.read())
            return data["token"]
    except urllib.error.HTTPError as e:
        resp_body = e.read().decode("utf-8", errors="replace")
        die(f"Failed to create installation token: {e.code} {e.reason}\n{resp_body}")
    return ""  # unreachable


def main() -> None:
    app_id = os.environ.get("GH_APP_ID", "").strip()
    private_key_raw = os.environ.get("GH_APP_PRIVATE_KEY", "").strip()

    if not app_id:
        die("Missing required environment variable: GH_APP_ID")
    if not private_key_raw:
        die("Missing required environment variable: GH_APP_PRIVATE_KEY")

    # Handle escaped newlines (matches pattern in octokit.ts)
    private_key = private_key_raw.replace("\\n", "\n")

    try:
        jwt_token = create_jwt(app_id, private_key)
    except ValueError as e:
        die(f"Failed to create JWT (malformed private key?): {e}")

    print(f"Finding installation for {TARGET_ORG}...", file=sys.stderr)
    installation_id = find_installation(jwt_token)
    print(f"Found installation {installation_id}", file=sys.stderr)

    print(f"Creating scoped token for {TARGET_REPOS}...", file=sys.stderr)
    token = create_installation_token(jwt_token, installation_id)
    print("Token created successfully", file=sys.stderr)

    # Only the token goes to stdout
    print(token)


if __name__ == "__main__":
    main()
