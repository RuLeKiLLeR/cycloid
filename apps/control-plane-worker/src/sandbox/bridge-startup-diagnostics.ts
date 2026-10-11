import { shellQuote } from "../utils";

/**
 * Builds the in-VM diagnostic script that captures why a sandbox bridge has not
 * connected: the bridge/clone/codex process table, the tail of the start-bridge
 * and egress logs, and control-plane reachability from inside the VM.
 */
export function buildBridgeStartupDiagnosticScript(args: {
  controlPlaneUrl: string;
  controlPlaneWsUrl: string;
}): string {
  const lines: string[] = ["set +e"];
  lines.push(
    'echo "[diag] date=$(date -Is 2>/dev/null || date)"',
    'echo "[diag] bridge processes"',
    'ps -eo pid,ppid,stat,etime,args | grep -E "(/app/start-bridge|/app/bridge/bundle|node /app|codex|git clone)" | grep -v grep || true',
    "for path in /tmp/cycloid-start-bridge.log /tmp/cycloid-egress.log; do",
    '  if [ -s "$path" ]; then',
    '    echo "[diag] tail $path"',
    '    tail -200 "$path"',
    "  else",
    '    echo "[diag] missing $path"',
    "  fi",
    "done",
    `control_plane_base=${shellQuote(args.controlPlaneUrl)}`,
    `control_plane_ws=${shellQuote(args.controlPlaneWsUrl)}`,
    'for url in "$control_plane_base" "$control_plane_ws"; do',
    '  echo "[diag] curl $url"',
    '  curl -sS -o /dev/null --connect-timeout 3 --max-time 8 -w "http_code=%{http_code} remote_ip=%{remote_ip} connect=%{time_connect} tls=%{time_appconnect} total=%{time_total}\\n" "$url" || true',
    "done",
  );
  return lines.join("\n");
}
