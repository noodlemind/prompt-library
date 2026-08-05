"""Harbor external agent that bridges to the Node stdio agent (agent.mjs).

Harbor invokes this class via:

    harbor run -d terminal-bench@2.0 --task-name cobol-modernization \
        --agent evals.external.terminal_bench.harbor_agent:StdioBridgeAgent ...

All decision-making (model driver, budget prechecks, telemetry) happens in the
Node process; this wrapper only executes each requested command inside the
Harbor environment and pumps results back over the line-delimited JSON
protocol documented in agent.mjs.

Configuration comes from allowlisted agent environment values set by the
release runner:

    HARNESS_EVAL_TB_CONDITION    path to the condition JSON (required)
    HARNESS_EVAL_TB_TELEMETRY_FILE path to the host-side result document
    HARNESS_EVAL_HOST_NODE / _SHA256 attested host Node path and digest

The exact BaseEnvironment exec surface can differ between Harbor releases, so
`_exec` resolves the method defensively and normalizes the result shape. This
wrapper is exercised for real at release time; repository tests cover the Node
side of the protocol.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import inspect
import json
import os
import pathlib
import re
import stat
import sys
import tempfile

try:
    from harbor.agents.base import BaseAgent
except ImportError:  # pragma: no cover - lets CI import-check the module without harbor
    BaseAgent = object


class StdioBridgeAgent(BaseAgent):
    _EVIDENCE_PROBE = "/opt/eval-runtime/evidence-probe"
    _CAPTURE_RUNNER = "/opt/eval-runtime/bounded-exec"
    _HARNESS_CLI = "/opt/harness-bundle/harness-cli"
    _EVIDENCE_BEFORE = ".harness/eval-before.json"
    _MAX_PARSED_JSON_BYTES = 2 * 1024 * 1024
    _MAX_DONE_FILE_BYTES = 4 * 1024 * 1024
    _MAX_PROTOCOL_LINE_BYTES = 512 * 1024
    _MAX_COMMAND_BYTES = 64 * 1024
    _MAX_HOST_EXECUTABLE_BYTES = 256 * 1024 * 1024
    _MODEL_STDOUT_BYTES = 6_000
    _MODEL_STDERR_BYTES = 2_000

    @staticmethod
    def _node_descriptor_path(descriptor: int) -> str:
        if sys.platform != "linux" or not os.path.isdir("/proc/self/fd"):
            raise RuntimeError("attested host Node requires Linux descriptor-based execution")
        return f"/proc/self/fd/{descriptor}"

    def _open_attested_node(self, node: str, expected_node_hash: str) -> int:
        no_follow = getattr(os, "O_NOFOLLOW", None)
        if not isinstance(no_follow, int) or no_follow == 0:
            raise RuntimeError("attested host Node requires O_NOFOLLOW support")
        if os.path.islink(node):
            raise RuntimeError("attested host Node executable must not be a symlink")
        resolved = os.path.realpath(node)
        descriptor = os.open(
            resolved,
            os.O_RDONLY | no_follow | getattr(os, "O_NONBLOCK", 0),
        )
        try:
            before = os.fstat(descriptor)
            if (
                not stat.S_ISREG(before.st_mode)
                or before.st_size <= 0
                or before.st_size > self._MAX_HOST_EXECUTABLE_BYTES
                or not before.st_mode & 0o111
                or before.st_mode & 0o022
            ):
                raise RuntimeError("attested host Node executable is not a protected executable regular file")
            digest = hashlib.sha256()
            while True:
                chunk = os.read(descriptor, 64 * 1024)
                if not chunk:
                    break
                digest.update(chunk)
            after = os.fstat(descriptor)
            stable = all(
                getattr(before, field) == getattr(after, field)
                for field in ("st_dev", "st_ino", "st_size", "st_mode", "st_mtime_ns", "st_ctime_ns")
            )
            if not stable:
                raise RuntimeError("attested host Node executable changed while being hashed")
            if digest.hexdigest() != expected_node_hash:
                raise RuntimeError("attested host Node executable digest mismatch")
            return descriptor
        except BaseException:
            os.close(descriptor)
            raise
    _CAPTURE_STDOUT_BYTES = 32 * 1024
    _CAPTURE_STDERR_BYTES = 16 * 1024
    _DEFAULT_EXEC_TIMEOUT_MS = 120_000
    _REDACTED_SECRET = "[REDACTED_SECRET]"
    _SECRET_NAME = re.compile(
        r"(?:API_?KEY|TOKEN|PASSWORD|PASSWD|PASS|SECRET|CREDENTIALS?|(?:^|_)KEY(?:_|$)|(?:^|_)PAT(?:_|$))",
        re.IGNORECASE,
    )
    _EVENT_KEYS = {
        "version", "id", "ts", "type", "result", "exitCode", "plan",
        "phase", "gate", "decision", "blockedReason", "mutation", "success",
        "durationMs", "checks",
    }
    _EVIDENCE_REASONS = {
        "before-git-state-digest-mismatch",
        "before-manifest-digest-mismatch",
        "before-manifest-unavailable",
        "workspace-ancestor-identity-ambiguous",
        "workspace-depth-limit-exceeded",
        "workspace-directory-limit-exceeded",
        "workspace-directory-unreadable",
        "workspace-entry-changed-during-read",
        "workspace-entry-not-regular-file",
        "workspace-file-limit-exceeded",
        "workspace-file-byte-limit-exceeded",
        "git-state-unavailable",
        "workspace-node-limit-exceeded",
        "workspace-root-unreadable",
        "workspace-total-byte-limit-exceeded",
        "workspace-unsupported-node",
        "workspace-evidence-unavailable",
    }
    @staticmethod
    def name() -> str:
        return "engineer-harness-stdio-bridge"

    def version(self) -> str | None:
        return "1"

    def _cfg(self, key: str, default: str | None = None) -> str | None:
        """Control config comes only from the runner's --ae allowlist."""
        return getattr(self, "_extra_env", {}).get(key) or default

    def _active_secrets(self) -> list[str]:
        values = []
        for source in (os.environ, getattr(self, "_extra_env", {})):
            for name, value in source.items():
                if self._SECRET_NAME.search(name) and isinstance(value, str) and len(value) >= 8:
                    values.append(value)
        return sorted(set(values), key=len, reverse=True)

    def _redact(self, value):
        secrets = self._active_secrets()

        def redact_text(text: str) -> str:
            for secret in secrets:
                text = text.replace(secret, self._REDACTED_SECRET)
            return text

        def visit(candidate):
            if isinstance(candidate, str):
                return redact_text(candidate)
            if isinstance(candidate, list):
                return [visit(entry) for entry in candidate]
            if isinstance(candidate, tuple):
                return tuple(visit(entry) for entry in candidate)
            if isinstance(candidate, dict):
                return {redact_text(str(key)): visit(entry) for key, entry in candidate.items()}
            return candidate

        return visit(value)

    def _contains_active_secret(self, value: str) -> bool:
        return any(secret in value for secret in self._active_secrets())

    @staticmethod
    def _completed_contained(result: dict) -> bool:
        return (
            result.get("code") == 0
            and result.get("timedOut") is False
            and result.get("containmentComplete") is True
        )

    async def setup(self, environment) -> None:
        condition = self._load_condition()
        for command in condition.get("setupCommands", []):
            result = await self._exec(environment, command)
            if not self._completed_contained(result):
                # A failed activation must surface as an infrastructure failure,
                # not run the trial as a silently contaminated treatment arm.
                # Include both streams: some environments fold stderr into stdout.
                raise RuntimeError(
                    f"setup command failed (exit {result['code']}): {command}\n"
                    f"stdout: {result['stdout'][-2000:]}\nstderr: {result['stderr'][-2000:]}"
                )
        # Setup mutations are not product work. Capture the baseline only
        # after activation succeeds and immediately before the model runs.
        # Probe failures are retained as explicit unavailable evidence; they
        # never change the benchmark task's correctness outcome.
        snapshot = await self._exec(
            environment,
            f"{self._EVIDENCE_PROBE} snapshot --output {self._EVIDENCE_BEFORE}",
            timeout_ms=60_000,
            parse_json=True,
        )
        parsed = snapshot.get("_parsedJson")
        if self._completed_contained(snapshot) and isinstance(parsed, dict) and parsed.get("available") is True:
            digest = parsed.get("manifestHash")
            git_digest = parsed.get("gitStateHash")
            self._evidence_snapshot = {
                "available": (
                    isinstance(digest, str)
                    and bool(re.fullmatch(r"[a-f0-9]{64}", digest))
                    and isinstance(git_digest, str)
                    and bool(re.fullmatch(r"[a-f0-9]{64}", git_digest))
                ),
                "manifestHash": digest,
                "gitStateHash": git_digest,
                "reason": None,
            }
            if not self._evidence_snapshot["available"]:
                self._evidence_snapshot["reason"] = "evidence-probe-snapshot-invalid"
        else:
            self._evidence_snapshot = {
                "available": False,
                "manifestHash": None,
                "gitStateHash": None,
                "reason": "evidence-probe-snapshot-unavailable",
            }

    async def run(self, instruction: str, environment, context) -> None:
        condition_path = self._cfg("HARNESS_EVAL_TB_CONDITION")
        if not condition_path:
            raise RuntimeError("HARNESS_EVAL_TB_CONDITION is not set (--ae agent env)")
        # These executable/code locations are code-owned. Allowing host process
        # environment variables to replace either would execute attacker-chosen
        # host code with the provider credential.
        node = os.environ.get("HARNESS_EVAL_HOST_NODE")
        expected_node_hash = os.environ.get("HARNESS_EVAL_HOST_NODE_SHA256")
        if not node or not os.path.isabs(node):
            raise RuntimeError("HARNESS_EVAL_HOST_NODE must name the attested absolute host Node executable")
        if not isinstance(expected_node_hash, str) or not re.fullmatch(r"[a-f0-9]{64}", expected_node_hash):
            raise RuntimeError("HARNESS_EVAL_HOST_NODE_SHA256 must pin the host Node executable")
        agent_mjs = str(pathlib.Path(__file__).with_name("agent.mjs"))
        instruction_path = pathlib.Path(condition_path).with_suffix(".instruction.txt")
        instruction_path.write_text(instruction)

        # Pass only minimal process settings and the runner's allowlisted
        # config. Provider credentials belong exclusively to the separate-UID
        # broker and never enter Harbor or this Node bridge process.
        bridge_env = {
            key: os.environ[key]
            for key in ("LANG", "LC_ALL", "SSL_CERT_FILE", "SSL_CERT_DIR")
            if key in os.environ
        }
        bridge_env.update(getattr(self, "_extra_env", {}))
        descriptor = self._open_attested_node(node, expected_node_hash)
        try:
            descriptor_node = self._node_descriptor_path(descriptor)
            proc = await asyncio.create_subprocess_exec(
                descriptor_node,
                agent_mjs,
                "--condition",
                condition_path,
                "--instruction",
                str(instruction_path),
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                env=bridge_env,
                limit=self._MAX_PROTOCOL_LINE_BYTES,
                pass_fds=(descriptor,),
            )
        finally:
            os.close(descriptor)
        saw_done = False
        try:
            while True:
                line = await proc.stdout.readline()
                if not line:
                    break
                message = json.loads(line)
                if message["type"] == "exec":
                    raw_command = message.get("command", "")
                    if not isinstance(raw_command, str) or self._contains_active_secret(raw_command):
                        result = {
                            "code": 126,
                            "stdout": "",
                            "stderr": "provider command blocked before sandbox execution",
                            "stdoutTruncated": False,
                            "stderrTruncated": False,
                            "timedOut": False,
                            "containmentMode": "bridge-local",
                            "containmentComplete": True,
                        }
                    else:
                        result = await self._exec(
                            environment, raw_command, timeout_ms=message.get("timeoutMs")
                        )
                    result = self._redact(result)
                    reply = {"type": "result", "id": message["id"], **result}
                    proc.stdin.write((json.dumps(reply) + "\n").encode())
                    await proc.stdin.drain()
                elif message["type"] == "verify":
                    result = await self._trusted_verify(environment)
                    reply = {
                        "type": "verification_result",
                        "id": message["id"],
                        **self._redact(result),
                    }
                    proc.stdin.write((json.dumps(reply) + "\n").encode())
                    await proc.stdin.drain()
                elif message["type"] == "done":
                    saw_done = True
                    if message.get("doneFilePersisted") is True:
                        message = self._load_persisted_done(message)
                    message = self._redact(message)
                    await self._enrich_done(environment, message)
                    self._populate_context(context, message)
                    break
        finally:
            if proc.returncode is None:
                proc.terminate()
            await proc.wait()
        if not saw_done:
            # A bridge that died without reporting is an infrastructure crash,
            # not an ordinary task failure — surface it as one.
            raise RuntimeError(
                f"stdio bridge exited without a done message (node exit {proc.returncode})"
            )

    async def _trusted_verify(self, environment) -> dict:
        """Run only the immutable verifier command and return a bounded attestation."""
        command = f"{self._HARNESS_CLI} verify --workspace . --json"
        result = await self._exec(
            environment,
            command,
            timeout_ms=10 * 60_000,
            parse_json=True,
        )
        parsed = result.get("_parsedJson")
        reported_plan = parsed.get("plan") if isinstance(parsed, dict) else None
        reported_evidence = parsed.get("evidencePath") if isinstance(parsed, dict) else None
        safe_plan = (
            isinstance(reported_plan, str)
            and len(reported_plan) <= 500
            and re.fullmatch(r"docs/plans/[A-Za-z0-9._/-]+\.md", reported_plan) is not None
            and ".." not in pathlib.PurePosixPath(reported_plan).parts
        )
        safe_evidence = (
            isinstance(reported_evidence, str)
            and len(reported_evidence) <= 500
            and re.fullmatch(r"\.harness/evidence/[A-Za-z0-9._/-]+\.json", reported_evidence) is not None
            and ".." not in pathlib.PurePosixPath(reported_evidence).parts
        )
        passed = (
            result.get("code") == 0
            and result.get("timedOut") is False
            and result.get("containmentComplete") is True
            and isinstance(parsed, dict)
            and parsed.get("outcome") == "passed"
            and parsed.get("unverifiedCriteria") == []
            and parsed.get("scopeViolations") == []
            and parsed.get("openHardGaps") == []
            and parsed.get("requiredReviews") == []
            and safe_plan
            and safe_evidence
        )
        def bounded_list(value):
            return value[:20] if isinstance(value, list) else []

        summary = {
            "outcome": parsed.get("outcome") if isinstance(parsed, dict) else "invalid",
            "passed": passed,
            "unverifiedCriteria": bounded_list(parsed.get("unverifiedCriteria")) if isinstance(parsed, dict) else [],
            "scopeViolations": bounded_list(parsed.get("scopeViolations")) if isinstance(parsed, dict) else [],
            "openHardGaps": bounded_list(parsed.get("openHardGaps")) if isinstance(parsed, dict) else [],
            "requiredReviews": bounded_list(parsed.get("requiredReviews")) if isinstance(parsed, dict) else [],
        }
        return {
            "code": result.get("code", 125),
            "stdout": json.dumps(summary, separators=(",", ":"))[:8_000],
            "stderr": str(result.get("stderr", ""))[-2_000:],
            "stdoutTruncated": result.get("stdoutTruncated") is True,
            "stderrTruncated": result.get("stderrTruncated") is True,
            "timedOut": result.get("timedOut") is True,
            "containmentMode": result.get("containmentMode"),
            "containmentComplete": result.get("containmentComplete") is True,
            "trustedVerification": True,
            "passed": passed,
            "plan": reported_plan if passed else None,
            "evidencePath": reported_evidence if passed else None,
        }

    def _load_persisted_done(self, reference: dict) -> dict:
        """Load the bounded full done ledger named by a small authenticated frame."""
        destination_value = self._cfg("HARNESS_EVAL_TB_TELEMETRY_FILE")
        expected_bytes = reference.get("doneBytes")
        expected_hash = reference.get("doneHash")
        if (
            not destination_value
            or not isinstance(expected_bytes, int)
            or expected_bytes <= 0
            or expected_bytes > self._MAX_DONE_FILE_BYTES
            or not isinstance(expected_hash, str)
            or re.fullmatch(r"[a-f0-9]{64}", expected_hash) is None
        ):
            raise RuntimeError("done reference is invalid or exceeds the bounded artifact limit")
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
        descriptor = os.open(destination_value, flags)
        try:
            before = os.fstat(descriptor)
            if not stat.S_ISREG(before.st_mode) or before.st_size != expected_bytes:
                raise RuntimeError("persisted done artifact is not the referenced regular file")
            chunks = []
            remaining = expected_bytes
            while remaining:
                chunk = os.read(descriptor, min(64 * 1024, remaining))
                if not chunk:
                    raise RuntimeError("persisted done artifact ended before its referenced size")
                chunks.append(chunk)
                remaining -= len(chunk)
            if os.read(descriptor, 1):
                raise RuntimeError("persisted done artifact exceeds its referenced size")
            after = os.fstat(descriptor)
            if (
                before.st_dev != after.st_dev
                or before.st_ino != after.st_ino
                or before.st_size != after.st_size
                or before.st_mtime_ns != after.st_mtime_ns
                or before.st_ctime_ns != after.st_ctime_ns
            ):
                raise RuntimeError("persisted done artifact changed while being read")
        finally:
            os.close(descriptor)
        payload = b"".join(chunks)
        if hashlib.sha256(payload).hexdigest() != expected_hash:
            raise RuntimeError("persisted done artifact digest does not match its protocol reference")
        try:
            parsed = json.loads(payload)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise RuntimeError(f"persisted done artifact is invalid JSON: {error}") from error
        if not isinstance(parsed, dict) or parsed.get("type") != "done":
            raise RuntimeError("persisted done artifact is not a done document")
        return parsed

    def _load_condition(self) -> dict:
        condition_path = self._cfg("HARNESS_EVAL_TB_CONDITION")
        if not condition_path:
            raise RuntimeError("HARNESS_EVAL_TB_CONDITION is not set (--ae agent env)")
        with open(condition_path) as fh:
            return json.load(fh)

    @staticmethod
    def _text(value) -> str:
        if value is None:
            return ""
        if isinstance(value, bytes):
            return value.decode("utf-8", errors="replace")
        return str(value)

    @staticmethod
    def _tail_text(value: bytes, maximum: int) -> str:
        return value[-maximum:].decode("utf-8", errors="replace")

    def _bounded_command(self, command: str, stdout_cap: int, stderr_cap: int, timeout_ms: int | None) -> str:
        encoded = base64.b64encode(command.encode("utf-8")).decode("ascii")
        return " ".join(
            [
                self._CAPTURE_RUNNER,
                encoded,
                str(stdout_cap),
                str(stderr_cap),
                str(max(0, int(timeout_ms or 0))),
            ]
        )

    @staticmethod
    def _decode_capture_envelope(stdout: str, stdout_cap: int, stderr_cap: int) -> dict:
        try:
            payload = json.loads(stdout)
            if not isinstance(payload, dict) or payload.get("version") != 1:
                raise ValueError("unsupported envelope")
            code = payload.get("code")
            if not isinstance(code, int):
                raise ValueError("invalid child exit status")
            encoded_stdout = payload.get("stdoutB64")
            encoded_stderr = payload.get("stderrB64")
            if not isinstance(encoded_stdout, str) or not isinstance(encoded_stderr, str):
                raise ValueError("missing encoded stream")
            # Reject inflated envelopes before decoding them.
            if len(encoded_stdout) > ((stdout_cap + 2) // 3) * 4 + 4:
                raise ValueError("stdout envelope exceeds capture cap")
            if len(encoded_stderr) > ((stderr_cap + 2) // 3) * 4 + 4:
                raise ValueError("stderr envelope exceeds capture cap")
            captured_stdout = base64.b64decode(encoded_stdout, validate=True)
            captured_stderr = base64.b64decode(encoded_stderr, validate=True)
            if len(captured_stdout) > stdout_cap or len(captured_stderr) > stderr_cap:
                raise ValueError("decoded stream exceeds capture cap")
            containment_mode = payload.get("containmentMode")
            containment_complete = payload.get("containmentComplete")
            timed_out = payload.get("timedOut")
            if containment_mode not in {"linux-process-census", "process-group-nonlinux"}:
                raise ValueError("invalid containment mode")
            if not isinstance(containment_complete, bool):
                raise ValueError("missing containment result")
            if not isinstance(timed_out, bool):
                raise ValueError("missing timeout result")
            return {
                "code": code,
                "stdout": captured_stdout,
                "stderr": captured_stderr,
                "stdoutTruncated": payload.get("stdoutTruncated") is True,
                "stderrTruncated": payload.get("stderrTruncated") is True,
                "timedOut": timed_out,
                "containmentMode": containment_mode,
                "containmentComplete": containment_complete,
            }
        except (ValueError, TypeError, json.JSONDecodeError) as error:
            raise RuntimeError(f"bounded command capture returned an invalid envelope: {error}") from error

    async def _exec(
        self,
        environment,
        command: str,
        timeout_ms: int | None = None,
        parse_json: bool = False,
    ) -> dict:
        """Execute through an in-sandbox bounded stream-capture envelope."""
        if not isinstance(command, str):
            return {
                "code": 126,
                "stdout": "",
                "stderr": "command must be a string",
                "stdoutTruncated": False,
                "stderrTruncated": False,
                "timedOut": False,
                "containmentMode": "bridge-local",
                "containmentComplete": True,
            }
        if len(command.encode("utf-8")) > self._MAX_COMMAND_BYTES:
            return {
                "code": 126,
                "stdout": "",
                "stderr": f"command exceeds {self._MAX_COMMAND_BYTES} bytes",
                "stdoutTruncated": False,
                "stderrTruncated": False,
                "timedOut": False,
                "containmentMode": "bridge-local",
                "containmentComplete": True,
            }
        exec_fn = getattr(environment, "exec", None) or getattr(environment, "execute", None)
        if exec_fn is None:
            raise RuntimeError("Harbor environment exposes no exec/execute method")
        effective_timeout_ms = (
            int(timeout_ms)
            if isinstance(timeout_ms, (int, float)) and not isinstance(timeout_ms, bool) and timeout_ms > 0
            else self._DEFAULT_EXEC_TIMEOUT_MS
        )
        effective_timeout_ms = min(effective_timeout_ms, 24 * 60 * 60 * 1000)
        stdout_cap = self._MAX_PARSED_JSON_BYTES if parse_json else self._CAPTURE_STDOUT_BYTES
        stderr_cap = self._CAPTURE_STDERR_BYTES
        bounded_command = self._bounded_command(command, stdout_cap, stderr_cap, effective_timeout_ms)
        try:
            # Give the immutable in-sandbox runner a small grace window to
            # prove process containment and emit its bounded envelope. Every
            # command, including setup, has a finite default deadline.
            outer_timeout = max(1, int((effective_timeout_ms + 999) / 1000)) + 5
            try:
                signature = inspect.signature(exec_fn)
                parameters = signature.parameters.values()
                supports_timeout = "timeout_sec" in signature.parameters or any(
                    parameter.kind is inspect.Parameter.VAR_KEYWORD
                    for parameter in parameters
                )
            except (TypeError, ValueError):
                supports_timeout = False
            if supports_timeout:
                try:
                    pending = exec_fn(command=bounded_command, timeout_sec=outer_timeout)
                except TypeError as error:
                    message = str(error)
                    timeout_keyword_rejected = "timeout_sec" in message and (
                        "unexpected keyword" in message or "invalid keyword" in message
                    )
                    if not timeout_keyword_rejected:
                        raise
                    pending = exec_fn(command=bounded_command)
            else:
                pending = exec_fn(command=bounded_command)
            # Harbor receives the inner deadline plus containment grace. The
            # bridge gives either Harbor signature the same final window to
            # return the bounded runner's envelope.
            result = await asyncio.wait_for(pending, timeout=outer_timeout + 5)
        except (asyncio.TimeoutError, TimeoutError):
            return {
                "code": 124,
                "stdout": "",
                "stderr": f"command timed out after {effective_timeout_ms}ms",
                "stdoutTruncated": False,
                "stderrTruncated": False,
                "timedOut": True,
                "containmentMode": "harbor-outer-timeout",
                "containmentComplete": False,
            }
        wrapper_code = getattr(result, "return_code", None)
        if wrapper_code is None:
            wrapper_code = getattr(result, "exit_code", 0)
        wrapper_stdout = getattr(result, "output", None)
        if wrapper_stdout is None:
            wrapper_stdout = getattr(result, "stdout", "")
        wrapper_stdout = self._text(wrapper_stdout)
        wrapper_stderr = self._text(getattr(result, "stderr", ""))
        if wrapper_code != 0:
            return {
                "code": wrapper_code,
                "stdout": wrapper_stdout[-self._MODEL_STDOUT_BYTES:],
                "stderr": wrapper_stderr[-self._MODEL_STDERR_BYTES:] or "bounded command capture failed",
                "stdoutTruncated": len(wrapper_stdout) > self._MODEL_STDOUT_BYTES,
                "stderrTruncated": len(wrapper_stderr) > self._MODEL_STDERR_BYTES,
                "timedOut": False,
                "containmentMode": "bounded-wrapper-failure",
                "containmentComplete": False,
            }
        try:
            captured = self._decode_capture_envelope(wrapper_stdout, stdout_cap, stderr_cap)
        except RuntimeError as error:
            return {
                "code": 125,
                "stdout": "",
                "stderr": str(error)[:self._MODEL_STDERR_BYTES],
                "stdoutTruncated": False,
                "stderrTruncated": len(str(error)) > self._MODEL_STDERR_BYTES,
                "timedOut": False,
                "containmentMode": "capture-envelope-invalid",
                "containmentComplete": False,
            }
        stdout_bytes = captured["stdout"]
        stderr_bytes = captured["stderr"]
        normalized = {
            "code": captured["code"],
            "stdout": self._tail_text(stdout_bytes, self._MODEL_STDOUT_BYTES),
            "stderr": self._tail_text(stderr_bytes, self._MODEL_STDERR_BYTES),
            "stdoutTruncated": captured["stdoutTruncated"] or len(stdout_bytes) > self._MODEL_STDOUT_BYTES,
            "stderrTruncated": captured["stderrTruncated"] or len(stderr_bytes) > self._MODEL_STDERR_BYTES,
            "timedOut": captured["timedOut"],
            "containmentMode": captured["containmentMode"],
            "containmentComplete": captured["containmentComplete"],
        }

        # Full JSON is private to code-owned evidence probes. Model-selected
        # commands, including Harness verify, never gain a parsed promotion.
        if parse_json and len(stdout_bytes) <= self._MAX_PARSED_JSON_BYTES:
            try:
                parsed = json.loads(stdout_bytes.decode("utf-8").strip())
            except (json.JSONDecodeError, TypeError, UnicodeDecodeError):
                parsed = None
            if parsed is not None:
                normalized["_parsedJson"] = parsed
        return self._redact(normalized)

    @staticmethod
    def _unavailable_evidence(reason: str) -> dict:
        return {
            "workspaceEvidence": {
                "available": False,
                "collectionMode": "bounded-typed-content-plus-git-state-v3",
                "containmentMode": None,
                "beforeManifestHash": None,
                "afterManifestHash": None,
                "diffHash": None,
                "changedPaths": [],
                "changedPathCount": 0,
                "changedPathsTruncated": False,
                "gitStateAvailable": False,
                "gitStatePresent": None,
                "beforeGitStateHash": None,
                "afterGitStateHash": None,
                "gitStateChanged": None,
                "reason": reason,
            },
            "harnessEvents": [],
            "harnessEventEvidence": {
                "available": False,
                "complete": False,
                "reason": reason,
                "retainedEvents": 0,
                "sourceTruncated": False,
                "projectionRejectedEvents": 0,
                "projectionRejectedChecks": 0,
            },
            "enforcement": {
                "hooksActive": False,
                "source": "unavailable",
            },
        }

    async def _collect_evidence(self, environment) -> dict:
        snapshot = getattr(self, "_evidence_snapshot", None) or {
            "available": False,
            "manifestHash": None,
            "gitStateHash": None,
            "reason": "evidence-probe-snapshot-not-attempted",
        }
        expected = snapshot.get("manifestHash")
        expected_git = snapshot.get("gitStateHash")
        if not (
            snapshot.get("available") is True
            and isinstance(expected, str)
            and re.fullmatch(r"[a-f0-9]{64}", expected)
            and isinstance(expected_git, str)
            and re.fullmatch(r"[a-f0-9]{64}", expected_git)
        ):
            return self._unavailable_evidence("evidence-probe-snapshot-unavailable")
        expected_flag = (
            f" --expected-before-hash {expected}"
            f" --expected-before-git-hash {expected_git}"
        )
        result = await self._exec(
            environment,
            f"{self._EVIDENCE_PROBE} collect --before {self._EVIDENCE_BEFORE}{expected_flag}",
            timeout_ms=120_000,
            parse_json=True,
        )
        parsed = result.get("_parsedJson")
        if not self._completed_contained(result) or not isinstance(parsed, dict):
            return self._unavailable_evidence("evidence-probe-collect-unavailable")
        workspace = parsed.get("workspaceEvidence")
        events = parsed.get("harnessEvents")
        event_evidence = parsed.get("harnessEventEvidence")
        enforcement = parsed.get("enforcement")
        if not isinstance(workspace, dict) or not isinstance(events, list) or not isinstance(enforcement, dict):
            return self._unavailable_evidence("evidence-probe-collect-invalid")
        # The read-only probe already allowlists fields. Bound once more at the
        # host bridge so a future probe regression cannot inflate the done file.
        hashes = [workspace.get(key) for key in ("beforeManifestHash", "afterManifestHash", "diffHash")]
        hashes_valid = all(isinstance(value, str) and re.fullmatch(r"[a-f0-9]{64}", value) for value in hashes)
        git_hashes = [workspace.get(key) for key in ("beforeGitStateHash", "afterGitStateHash")]
        git_hashes_valid = all(isinstance(value, str) and re.fullmatch(r"[a-f0-9]{64}", value) for value in git_hashes)
        available = (
            workspace.get("available") is True
            and hashes_valid
            and git_hashes_valid
            and workspace.get("gitStateAvailable") is True
            and isinstance(workspace.get("gitStatePresent"), bool)
            and isinstance(workspace.get("gitStateChanged"), bool)
        )
        paths = workspace.get("changedPaths") if isinstance(workspace.get("changedPaths"), list) else []
        changed_paths = [
            value[:500]
            for value in paths
            if isinstance(value, str) and not any(ord(char) < 32 or ord(char) == 127 for char in value)
        ][:200]
        raw_changed_count = workspace.get("changedPathCount")
        changed_count = (
            raw_changed_count
            if isinstance(raw_changed_count, int) and raw_changed_count >= len(changed_paths)
            else len(changed_paths)
        )
        containment_mode = workspace.get("containmentMode")
        if containment_mode not in {"descriptor-relative-procfs", "identity-checked-path-fallback"}:
            containment_mode = None
        safe_workspace = {
            "available": available,
            "collectionMode": "bounded-typed-content-plus-git-state-v3",
            "containmentMode": containment_mode,
            "beforeManifestHash": hashes[0] if available else None,
            "afterManifestHash": hashes[1] if available else None,
            "diffHash": hashes[2] if available else None,
            "changedPaths": changed_paths if available else [],
            "changedPathCount": changed_count if available else 0,
            "changedPathsTruncated": (
                bool(workspace.get("changedPathsTruncated")) or changed_count > len(changed_paths)
            ) if available else False,
            "gitStateAvailable": available,
            "gitStatePresent": workspace.get("gitStatePresent") if available else None,
            "beforeGitStateHash": git_hashes[0] if available else None,
            "afterGitStateHash": git_hashes[1] if available else None,
            "gitStateChanged": workspace.get("gitStateChanged") if available else None,
            "reason": None if available else (
                workspace.get("reason")
                if workspace.get("reason") in self._EVIDENCE_REASONS
                else "evidence-probe-reported-unavailable"
            ),
        }
        safe_events = []
        bridge_rejected_events = max(0, len(events) - 200)
        for event in events[-200:]:
            if not isinstance(event, dict) or not isinstance(event.get("type"), str):
                bridge_rejected_events += 1
                continue
            projected = {key: event[key] for key in self._EVENT_KEYS if key in event}
            try:
                if len(json.dumps(projected, separators=(",", ":"))) > 8_192:
                    bridge_rejected_events += 1
                    continue
            except (TypeError, ValueError):
                bridge_rejected_events += 1
                continue
            safe_events.append(projected)
        raw_rejected_events = event_evidence.get("projectionRejectedEvents") if isinstance(event_evidence, dict) else 0
        raw_rejected_checks = event_evidence.get("projectionRejectedChecks") if isinstance(event_evidence, dict) else 0
        probe_rejected_events = raw_rejected_events if isinstance(raw_rejected_events, int) and 0 <= raw_rejected_events <= 1_000_000 else 0
        retained_events = event_evidence.get("retainedEvents") if isinstance(event_evidence, dict) else None
        if not isinstance(retained_events, int) or retained_events != len(events):
            bridge_rejected_events += 1
        rejected_events = min(1_000_000, probe_rejected_events + bridge_rejected_events)
        rejected_checks = raw_rejected_checks if isinstance(raw_rejected_checks, int) and 0 <= raw_rejected_checks <= 1_000_000 else 0
        projection_complete = rejected_events == 0 and rejected_checks == 0
        safe_event_evidence = {
            "available": isinstance(event_evidence, dict) and event_evidence.get("available") is True,
            "complete": (
                isinstance(event_evidence, dict)
                and event_evidence.get("complete") is True
                and projection_complete
            ),
            "reason": None,
            "retainedEvents": len(safe_events),
            "sourceTruncated": (
                isinstance(event_evidence, dict) and event_evidence.get("sourceTruncated") is True
            ) or len(events) > 200,
            "projectionRejectedEvents": rejected_events,
            "projectionRejectedChecks": rejected_checks,
        }
        if not safe_event_evidence["complete"]:
            reported_reason = event_evidence.get("reason") if isinstance(event_evidence, dict) else None
            allowed_reasons = {
                "harness-events-empty",
                "harness-events-not-found",
                "harness-events-unreadable",
                "harness-events-byte-limit-exceeded",
                "harness-events-retention-limit-exceeded",
                "harness-events-projection-rejected",
            }
            reason_parts = reported_reason.split(";") if isinstance(reported_reason, str) else []
            if bridge_rejected_events:
                safe_event_evidence["reason"] = "harness-events-projection-rejected"
            else:
                safe_event_evidence["reason"] = reported_reason if reason_parts and all(part in allowed_reasons for part in reason_parts) else "harness-event-evidence-unavailable"
        return {
            "workspaceEvidence": safe_workspace,
            "harnessEvents": safe_events,
            "harnessEventEvidence": safe_event_evidence,
            "enforcement": {
                # The probe's stdout crosses the sandbox boundary and is
                # therefore agent-forgeable: nothing the sandbox prints may
                # establish enforcement facts. The genuine probe hard-codes
                # hooksActive false; only a future TRUSTED supervisor channel
                # (outside the sandbox) may ever assert true, and a forged
                # policyBypassAchieved boolean must never mask or mint a
                # safety verdict.
                "hooksActive": False,
                "source": "sandbox-untrusted",
            },
        }

    async def _observe_mounts(self, environment) -> dict:
        condition = self._load_condition()
        runtime = condition.get("runtime") if isinstance(condition, dict) else None
        expected = runtime.get("expectedMountTargets") if isinstance(runtime, dict) else None
        probe_targets = runtime.get("mountProbeTargets") if isinstance(runtime, dict) else None
        safe_targets = (
            isinstance(expected, list)
            and 0 < len(expected) <= 32
            and all(
                isinstance(target, str)
                and len(target) <= 500
                and re.fullmatch(r"/opt/(?:eval-runtime|harness-bundle)/[A-Za-z0-9._/-]+", target)
                and ".." not in pathlib.PurePosixPath(target).parts
                for target in expected
            )
            and len(set(expected)) == len(expected)
            and isinstance(probe_targets, list)
            and len(expected) <= len(probe_targets) <= 32
            and all(
                isinstance(target, str)
                and len(target) <= 500
                and re.fullmatch(r"/opt/(?:eval-runtime|harness-bundle)/[A-Za-z0-9._/-]+", target)
                and ".." not in pathlib.PurePosixPath(target).parts
                for target in probe_targets
            )
            and len(set(probe_targets)) == len(probe_targets)
            and all(target in probe_targets for target in expected)
        )
        if not safe_targets:
            return {
                "version": "eval-mount-policy.v1",
                "source": "sandbox-observed",
                "targets": [],
                "existingTargets": [],
                "allReadOnly": False,
                "complete": False,
            }
        encoded = base64.b64encode(json.dumps(probe_targets, separators=(",", ":")).encode()).decode("ascii")
        result = await self._exec(
            environment,
            f"{self._EVIDENCE_PROBE} mounts --expected-b64 {encoded}",
            timeout_ms=60_000,
            parse_json=True,
        )
        parsed = result.get("_parsedJson")
        if not self._completed_contained(result) or not isinstance(parsed, dict):
            parsed = {}
        raw_targets = parsed.get("targets")
        raw_existing = parsed.get("existingTargets")
        targets = raw_targets if isinstance(raw_targets, list) else []
        existing = raw_existing if isinstance(raw_existing, list) else []
        # Preserve the condition's policy order. The broader probe set exists
        # to detect treatment-only mounts leaking into the generic arm, so any
        # observed probe target outside `expected` invalidates completeness
        # instead of being silently projected away.
        projected = [target for target in expected if target in targets]
        projected_existing = [target for target in expected if target in existing]
        unexpected_targets = [target for target in probe_targets if target not in expected and target in targets]
        unexpected_existing = [target for target in probe_targets if target not in expected and target in existing]
        raw_projection_valid = (
            parsed.get("version") == "eval-mount-policy.v1"
            and parsed.get("source") == "sandbox-observed"
            and isinstance(raw_targets, list)
            and isinstance(raw_existing, list)
            and all(isinstance(target, str) and target in probe_targets for target in targets)
            and all(isinstance(target, str) and target in probe_targets for target in existing)
            and len(set(targets)) == len(targets)
            and len(set(existing)) == len(existing)
            and len(projected) + len(unexpected_targets) == len(targets)
            and len(projected_existing) + len(unexpected_existing) == len(existing)
        )
        return {
            "version": "eval-mount-policy.v1",
            "source": "sandbox-observed",
            "targets": projected,
            "existingTargets": projected_existing,
            "allReadOnly": parsed.get("allReadOnly") is True,
            "complete": (
                parsed.get("complete") is True
                and raw_projection_valid
                and not unexpected_targets
                and not unexpected_existing
            ),
        }

    def _rewrite_done_file(self, done: dict) -> bool:
        destination_value = self._cfg("HARNESS_EVAL_TB_TELEMETRY_FILE")
        if not destination_value:
            return False
        destination = pathlib.Path(destination_value)
        destination.parent.mkdir(parents=True, exist_ok=True)
        temporary_name = None
        try:
            done = self._redact(done)
            with tempfile.NamedTemporaryFile(
                mode="w",
                encoding="utf-8",
                dir=destination.parent,
                prefix=f".{destination.name}.",
                suffix=".tmp",
                delete=False,
            ) as temporary:
                temporary_name = temporary.name
                json.dump(done, temporary, separators=(",", ":"))
                temporary.write("\n")
                temporary.flush()
                os.fsync(temporary.fileno())
            os.replace(temporary_name, destination)
            return True
        except Exception:
            if temporary_name:
                try:
                    os.unlink(temporary_name)
                except OSError:
                    pass
            return False

    async def _enrich_done(self, environment, done: dict) -> None:
        sanitized = self._redact(done)
        done.clear()
        done.update(sanitized)
        try:
            evidence = await self._collect_evidence(environment)
        except Exception:
            evidence = self._unavailable_evidence("evidence-probe-bridge-error")
        done.update(evidence)
        try:
            done["mountEvidence"] = await self._observe_mounts(environment)
        except Exception:
            done["mountEvidence"] = {
                "version": "eval-mount-policy.v1",
                "source": "sandbox-observed",
                "targets": [],
                "existingTargets": [],
                "allReadOnly": False,
                "complete": False,
            }
        sanitized = self._redact(done)
        done.clear()
        done.update(sanitized)
        if not self._rewrite_done_file(done):
            # Keep this diagnostic in Harbor context/the in-memory outcome. A
            # host-file failure is observability loss, not task incorrectness.
            done["evidenceBridge"] = {
                "telemetryPersisted": False,
                "reason": "host-telemetry-rewrite-unavailable",
            }

    def _populate_context(self, context, done: dict) -> None:
        """Attach the bridge outcome to Harbor's AgentContext.

        AgentContext is a Pydantic model: assigning fields it does not define
        raises ValueError, so everything bridge-specific goes into `metadata`
        (a supported dict field), and only recognized token/cost fields are
        attempted individually. Every write is exception-safe — a context
        schema change must never turn a completed trial into a crash.
        """
        safe_done = self._redact(done)
        payload = {
            "answer": safe_done.get("answer"),
            "stopReason": safe_done.get("stopReason"),
            "steps": safe_done.get("steps"),
            "telemetry": safe_done.get("telemetry"),
            "workspaceEvidence": safe_done.get("workspaceEvidence"),
            "harnessEvents": safe_done.get("harnessEvents"),
            "harnessEventEvidence": safe_done.get("harnessEventEvidence"),
            "enforcement": safe_done.get("enforcement"),
            "mountEvidence": safe_done.get("mountEvidence"),
        }
        try:
            existing = getattr(context, "metadata", None)
            if isinstance(existing, dict):
                existing["stdio_bridge"] = payload
            else:
                setattr(context, "metadata", {"stdio_bridge": payload})
        except Exception:
            pass
        totals = (safe_done.get("telemetry") or {}).get("totals") or {}
        for attr, value in (
            ("n_input_tokens", totals.get("promptTokens")),
            # Harbor 0.20.0 AgentContext names the cached-token field n_cache_tokens.
            ("n_cache_tokens", totals.get("cachedTokens")),
            ("n_output_tokens", totals.get("outputTokens")),
            ("cost_usd", totals.get("localCostUsd")),
        ):
            if value is None:
                continue
            try:
                setattr(context, attr, value)
            except Exception:
                pass
