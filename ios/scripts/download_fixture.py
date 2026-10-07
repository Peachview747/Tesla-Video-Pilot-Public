"""Deterministic loopback HTTPS media server for native downloader integration."""
import http.server
import json
import re
import ssl
import socketserver
import sys
import threading
import time
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

LENGTH = 16 * 1024 * 1024 + 17
BODY = (bytes(range(251)) * (LENGTH // 251 + 1))[:LENGTH]
METRICS = {"max_parallel": 0, "max_query_parallel": 0, "head_requests": 0,
           "handoff_remainders": 0, "handoff_zero_remainders": 0,
           "query_handoff_remainders": 0, "query_handoff_zero_remainders": 0,
           "query_no_cr_handoff_remainders": 0, "query_no_cr_handoff_zero_remainders": 0,
           "query_ignored_probes": 0, "query_ignored_header_probes": 0,
           "query_resume_probes": 0, "query_resume_cached_requests": 0,
           "legacy_resume_probes": 0, "legacy_resume_cached_requests": 0}
LOCK = threading.Lock()
ACTIVE = 0


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_):
        pass

    def do_HEAD(self):
        with LOCK:
            METRICS["head_requests"] += 1
        self.send_error(405)

    def do_GET(self):
        global ACTIVE
        endpoint = urlsplit(self.path)
        route = endpoint.path.strip("/")
        if route == "metrics":
            with LOCK:
                data = json.dumps(METRICS).encode()
            self.send_response(200)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        header_range = re.fullmatch(r"bytes=(\d+)-(\d+)", self.headers.get("Range", ""))
        params = parse_qs(endpoint.query, keep_blank_values=True)
        query_route = route.startswith("query")
        query_range = params.get("range")
        query_requested = re.fullmatch(r"(\d+)-(\d+)", query_range[0]) if query_route and query_range and len(query_range) == 1 else None
        requested = query_requested or header_range
        start, end = (int(v) for v in requested.groups()) if requested else (0, LENGTH - 1)
        is_oracle = bool(header_range and end - start + 1 <= 16_384)
        is_probe_request = requested and start == end == 0
        if query_route:
            # Google-style query slices must not also contain HTTP Range, which
            # can apply a second offset. Small header probes act as the oracle.
            if params.get("token") != ["PRIVATE+VALUE/TOKEN="]:
                self.send_error(400, "Media query token changed")
                return
            if query_range and (not query_requested or header_range):
                self.send_error(400, "Invalid or double-applied query range")
                return
            if route not in ("query-ignored", "query-wrong-offset") and not query_range and not is_oracle:
                self.send_error(400, "Query transport required")
                return
            if route == "query-ignored" and is_probe_request:
                with LOCK:
                    METRICS["query_ignored_probes" if query_range else "query_ignored_header_probes"] += 1
            if route == "query-resume":
                with LOCK:
                    if is_probe_request:
                        METRICS["query_resume_probes"] += 1
                    elif start == 0:
                        METRICS["query_resume_cached_requests"] += 1
        elif route == "legacy-resume":
            with LOCK:
                if is_probe_request:
                    METRICS["legacy_resume_probes"] += 1
                elif start == 0:
                    METRICS["legacy_resume_cached_requests"] += 1
        kind = route.removeprefix("query-") if route.startswith("query-") else route
        if route == "query":
            kind = "normal"
        no_cr = bool(query_range and query_route and (kind.startswith("no-cr") or kind == "wrong-offset"))
        if kind == "no-cr":
            kind = "normal"
        elif kind.startswith("no-cr-"):
            kind = kind.removeprefix("no-cr-")
        ranged = requested and kind != "ignored"
        # This endpoint ignores only query ranges, so the fallback must remove
        # the query parameter and independently verify header range support.
        if route == "query-ignored":
            ranged = requested and not query_range
        if not ranged:
            start, end = 0, LENGTH - 1
        is_probe = start == end == 0 and ranged
        is_verification = ranged and end - start + 1 <= 16_384
        entire_entity = kind == "handoff-zero" and start == 0 and end == LENGTH - 1
        measured = ranged and not is_verification and kind == "normal"
        if measured:
            with LOCK:
                ACTIVE += 1
                key = "max_query_parallel" if query_route else "max_parallel"
                METRICS[key] = max(METRICS[key], ACTIVE)
        try:
            if measured:
                time.sleep(0.5)
            if kind == "handoff" and not is_verification and start != 0:
                if end == LENGTH - 1 and end - start > 4 * 1024 * 1024:
                    with LOCK:
                        prefix = "query_no_cr_" if no_cr else ("query_" if query_route else "")
                        METRICS[prefix + "handoff_remainders"] += 1
                else:
                    time.sleep(2)
            if kind == "handoff-zero" and not is_verification:
                if entire_entity:
                    with LOCK:
                        prefix = "query_no_cr_" if no_cr else ("query_" if query_route else "")
                        METRICS[prefix + "handoff_zero_remainders"] += 1
                else:
                    time.sleep(2)
            unsafe_existing = route == "existing-range" and not is_verification
            self.send_response(206 if ranged and kind != "compat" and not entire_entity and not no_cr and not unsafe_existing else 200)
            self.send_header("Content-Type", "video/mp4")
            self.send_header("Content-Length", str(end - start + 1))
            # Deliberately never advertises Accept-Ranges.
            if ranged and not entire_entity and not no_cr and not unsafe_existing:
                claimed_start = start + 1 if kind == "bad-range" and not is_verification else start
                self.send_header("Content-Range", f"bytes {claimed_start}-{end}/{LENGTH}")
            self.end_headers()
            truncated = kind == "truncated" and not is_verification
            payload_start, payload_end = start, (end if truncated else end + 1)
            if route == "query-wrong-offset" and query_requested and start != 0:
                payload_start += 1
                payload_end += 1
            for offset in range(payload_start, payload_end, 64 * 1024):
                self.wfile.write(BODY[offset:min(payload_end, offset + 64 * 1024)])
            if truncated:
                self.close_connection = True
        except (BrokenPipeError, ConnectionResetError, ssl.SSLError):
            pass
        finally:
            if measured:
                with LOCK:
                    ACTIVE -= 1


class LoopbackServer(http.server.ThreadingHTTPServer):
    def server_bind(self):
        # HTTPServer normally reverse-resolves the bind address. CI runners can
        # stall on that lookup; this fixture needs only a numeric loopback host.
        socketserver.TCPServer.server_bind(self)
        self.server_name = "127.0.0.1"
        self.server_port = self.server_address[1]


print("Starting native download HTTPS fixture", flush=True)
server = LoopbackServer(("127.0.0.1", 0), Handler)
context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain(sys.argv[1], sys.argv[2])
server.socket = context.wrap_socket(server.socket, server_side=True)
Path(sys.argv[3]).write_text(f"https://127.0.0.1:{server.server_address[1]}")
print("Native download HTTPS fixture ready", flush=True)
server.serve_forever()
