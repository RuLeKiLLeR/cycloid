# E2B Sandbox Template

This package owns the E2B template source for normal Cycloid repo sessions,
including the shared runtime helper scripts under `apps/sandbox-e2b/scripts/`.

Build the bridge and MCP bundles before building the template:

```bash
npm run bundle:sandbox-core-apps
npm run -w @cycloid/sandbox-e2b build-template -- --name cycloid-sandbox-dev-$USER
```

The template contains runtime tools and bundled Cycloid code only. It does not
start the sandbox bridge as an E2B template start command because bridge startup
needs per-session environment variables from `Sandbox.create()` and the later
runtime start command.

The template build sets the runtime resource profile to 2 vCPU and 4096 MB RAM.
E2B applies those resources to sandboxes created from the template tag.

The first-cutover repo checkout path is `/workspace/repo`. The template keeps
E2B's default `user` runtime with `HOME=/home/user`; build-time root installs
are chowned or copied into user-readable locations before readiness.

## Desktop Package Measurement

PR 5 of `docs/superpowers/specs/2026-07-07-session-desktop-vnc-cua-functional-spec.md`
adds the desktop package set to the shared E2B base image but does not start any
desktop services. Versions come from Debian Bookworm apt candidates resolved from
`python:3.12-slim-bookworm` on 2026-07-07:

```text
fonts-dejavu-core=2.37-6
fonts-liberation=1:1.07.4-11
fonts-noto-color-emoji=2.042-0+deb12u1
novnc=1:1.3.0-1
openbox=3.6.1-10
scrot=1.8.1-1
websockify=0.10.0+dfsg1-4+b1
wmctrl=1.07-7+b1
x11vnc=0.9.16-9
xdotool=1:3.20160805.1-5
xvfb=2:21.1.7-3+deb12u12
```

Measured locally with `apt-get install -y --no-install-recommends` in the public
`python:3.12-slim-bookworm` image:

```text
SIZE_DELTA_KIB=598840
```

The same smoke proved these installed targets without starting services:
`Xvfb`, `openbox`, `x11vnc`, `websockify`, `/usr/share/novnc/vnc.html`,
`xdotool`, `wmctrl`, `scrot`, and `fc-match sans`.

Rollback is a straight removal of the apt package entries plus the matching
`ready-check.sh` and `template-dockerfile.test.ts` assertions. If the size or
reliability cost is too high during the supervisor slices, revert this package
set before wiring desktop startup.

## XFCE Desktop Package Measurement

PR 1 of `docs/superpowers/specs/2026-07-08-session-desktop-xfce-hardening-spec.md`
compares the current Openbox desktop stack against XFCE-core and Debian's
`xfce4` metapackage from the same `python:3.12-slim-bookworm` base image:

```bash
node scripts/measure-desktop-package-alternatives.mjs --print-commands
node scripts/measure-desktop-package-alternatives.mjs --json
```

The helper measures these package alternatives with
`apt-get install -y --no-install-recommends`, records requested package versions
with `dpkg-query`, and reports `SIZE_DELTA_KIB` from rootfs `du -sx -k /`
before/after install:

- `minimal-openbox-current` - current `Xvfb + openbox + tint2 + x11vnc + websockify/noVNC` stack.
- `xfce-core` - current common desktop packages plus `dbus-x11`, `xfwm4`,
  `xfce4-panel`, `xfdesktop4`, `xfce4-session`, `xfce4-settings`, `xfconf`,
  `thunar`, `xfce4-terminal`, `adwaita-icon-theme`, and `hicolor-icon-theme`.
- `xfce4-metapackage` - common desktop packages plus Debian `xfce4`.
- `xfce4-goodies-upper-bound` - optional rejected upper bound, included only
  with `--include-goodies`.

Proceed with the XFCE-core runtime change only if XFCE-core adds no more than
`1048576 KiB` over the existing base and disposable desktop-ready p95 remains
under 20 seconds.

Measurement status for this worktree on 2026-07-08: the helper and parser tests
passed, but local Docker server availability did not complete (`docker version`
printed client info and hung before server info), so fresh size deltas were not
recorded in this checkout. The previous Openbox baseline remains
`SIZE_DELTA_KIB=598840`; run the helper above before publishing the template
change and include the resulting deltas in the PR body.
