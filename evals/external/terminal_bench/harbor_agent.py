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

The exact BaseEnvironment exec surface can differ between Harbor releases, so
`_exec` resolves the method defensively and normalizes the result shape. This
wrapper is exercised for real at release time; repository tests cover the Node
side of the protocol.
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import pathlib
import re
import tempfile

try:
    from harbor.agents.base import BaseAgent
except ImportError:  # pragma: no cover - lets CI import-check the module without harbor
    BaseAgent = object


class StdioBridgeAgent(BaseAgent):
    _EVIDENCE_PROBE = "/opt/harness-bundle/evidence-probe"
    _CAPTURE_RUNNER = "/opt/harness-bundle/bounded-exec"
    _EVIDENCE_BEFORE = ".harness/eval-before.json"
    _MAX_PARSED_JSON_BYTES = 2 * 1024 * 1024
    _MAX_COMMAND_BYTES = 64 * 1024
    _MODEL_STDOUT_BYTES = 6_000
    _MODEL_STDERR_BYTES = 2_000
    _CAPTURE_STDOUT_BYTES = 32 * 1024
    _CAPTURE_STDERR_BYTES = 16 * 1024
    _REDACTED_SECRET = "[REDACTED_SECRET]"
    _SECRET_NAME = re.compile(r"(?:API_KEY|TOKEN|PASSWORD|SECRET)$", re.IGNORECASE)
    _EVENT_KEYS = {
        "version", "id", "ts", "type", "result", "exitCode", "plan",
        "phase", "gate", "decision", "blockedReason", "mutation", "success",
        "durationMs", "checks",
    }
    _EVIDENCE_REASONS = {
        "before-manifest-unavailable",
        "workspace-directory-unreadable",
        "workspace-entry-unreadable",
        "workspace-file-limit-exceeded",
        "workspace-file-byte-limit-exceeded",
        "workspace-total-byte-limit-exceeded",
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

    async def setup(self, environment) -> None:
        condition = self._load_condition()
        for command in condition.get("setupCommands", []):
            result = await self._exec(environment, command)
            if result["code"] != 0:
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
        if snapshot.get("code") == 0 and isinstance(parsed, dict) and parsed.get("available") is True:
            digest = parsed.get("manifestHash")
            self._evidence_snapshot = {
                "available": isinstance(digest, str) and bool(re.fullmatch(r"[a-f0-9]{64}", digest)),
                "manifestHash": digest,
                "reason": None,
            }
            if not self._evidence_snapshot["available"]:
                self._evidence_snapshot["reason"] = "evidence-probe-snapshot-invalid"
        else:
            self._evidence_snapshot = {
                "available": False,
                "manifestHash": None,
                "reason": "evidence-probe-snapshot-unavailable",
            }

    async def run(self, instruction: str, environment, context) -> None:
        condition_path = self._cfg("HARNESS_EVAL_TB_CONDITION")
        if not condition_path:
            raise RuntimeError("HARNESS_EVAL_TB_CONDITION is not set (--ae agent env)")
        # These executable/code locations are code-owned. Allowing host process
        # environment variables to replace either would execute attacker-chosen
        # host code with the provider credential.
        node = "node"
        agent_mjs = str(pathlib.Path(__file__).with_name("agent.mjs"))
        instruction_path = pathlib.Path(condition_path).with_suffix(".instruction.txt")
        instruction_path.write_text(instruction)

        # Pass only minimal process settings, the runner's allowlisted config,
        # and the condition-selected provider credential. Other host tokens and
        # passwords never enter the Node provider process.
        condition = self._load_condition()
        api_key_env = condition.get("apiKeyEnv", "OPENROUTER_API_KEY")
        bridge_env = {
            key: os.environ[key]
            for key in ("PATH", "LANG", "LC_ALL", "SSL_CERT_FILE", "SSL_CERT_DIR")
            if key in os.environ
        }
        bridge_env.update(getattr(self, "_extra_env", {}))
        if api_key_env in os.environ:
            bridge_env[api_key_env] = os.environ[api_key_env]
        proc = await asyncio.create_subprocess_exec(
            node,
            agent_mjs,
            "--condition",
            condition_path,
            "--instruction",
            str(instruction_path),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            env=bridge_env,
        )
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
                        }
                    else:
                        result = await self._exec(
                            environment, raw_command, timeout_ms=message.get("timeoutMs")
                        )
                    result = self._redact(result)
                    reply = {"type": "result", "id": message["id"], **result}
                    proc.stdin.write((json.dumps(reply) + "\n").encode())
                    await proc.stdin.drain()
                elif message["type"] == "done":
                    saw_done = True
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
            return {
                "code": code,
                "stdout": captured_stdout,
                "stderr": captured_stderr,
                "stdoutTruncated": payload.get("stdoutTruncated") is True,
                "stderrTruncated": payload.get("stderrTruncated") is True,
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
            return {"code": 126, "stdout": "", "stderr": "command must be a string"}
        if len(command.encode("utf-8")) > self._MAX_COMMAND_BYTES:
            return {
                "code": 126,
                "stdout": "",
                "stderr": f"command exceeds {self._MAX_COMMAND_BYTES} bytes",
            }
        exec_fn = getattr(environment, "exec", None) or getattr(environment, "execute", None)
        if exec_fn is None:
            raise RuntimeError("Harbor environment exposes no exec/execute method")
        stdout_cap = self._MAX_PARSED_JSON_BYTES if parse_json else self._CAPTURE_STDOUT_BYTES
        stderr_cap = self._CAPTURE_STDERR_BYTES
        bounded_command = self._bounded_command(command, stdout_cap, stderr_cap, timeout_ms)
        try:
            if timeout_ms:
                # Give the in-sandbox runner a small grace window to kill its
                # process group and emit a bounded timeout envelope.
                outer_timeout = max(1, int((timeout_ms + 999) / 1000)) + 5
                try:
                    result = await exec_fn(
                        command=bounded_command, timeout_sec=outer_timeout
                    )
                except TypeError:
                    result = await asyncio.wait_for(
                        exec_fn(command=bounded_command), timeout=outer_timeout
                    )
            else:
                result = await exec_fn(command=bounded_command)
        except (asyncio.TimeoutError, TimeoutError):
            return {
                "code": 124,
                "stdout": "",
                "stderr": f"command timed out after {timeout_ms}ms",
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
            }
        try:
            captured = self._decode_capture_envelope(wrapper_stdout, stdout_cap, stderr_cap)
        except RuntimeError as error:
            return {
                "code": 125,
                "stdout": "",
                "stderr": str(error)[:self._MODEL_STDERR_BYTES],
            }
        stdout_bytes = captured["stdout"]
        stderr_bytes = captured["stderr"]
        normalized = {
            "code": captured["code"],
            "stdout": self._tail_text(stdout_bytes, self._MODEL_STDOUT_BYTES),
            "stderr": self._tail_text(stderr_bytes, self._MODEL_STDERR_BYTES),
            "stdoutTruncated": captured["stdoutTruncated"] or len(stdout_bytes) > self._MODEL_STDOUT_BYTES,
            "stderrTruncated": captured["stderrTruncated"] or len(stderr_bytes) > self._MODEL_STDERR_BYTES,
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
                "collectionMode": "bounded-content-hash-manifest-v1",
                "containmentMode": None,
                "beforeManifestHash": None,
                "afterManifestHash": None,
                "diffHash": None,
                "changedPaths": [],
                "changedPathCount": 0,
                "changedPathsTruncated": False,
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
            "reason": "evidence-probe-snapshot-not-attempted",
        }
        expected = snapshot.get("manifestHash")
        expected_flag = f" --expected-before-hash {expected}" if snapshot.get("available") and expected else ""
        result = await self._exec(
            environment,
            f"{self._EVIDENCE_PROBE} collect --before {self._EVIDENCE_BEFORE}{expected_flag}",
            timeout_ms=120_000,
            parse_json=True,
        )
        parsed = result.get("_parsedJson")
        if result.get("code") != 0 or not isinstance(parsed, dict):
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
        available = workspace.get("available") is True and hashes_valid
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
            "collectionMode": "bounded-content-hash-manifest-v1",
            "containmentMode": containment_mode,
            "beforeManifestHash": hashes[0] if available else None,
            "afterManifestHash": hashes[1] if available else None,
            "diffHash": hashes[2] if available else None,
            "changedPaths": changed_paths if available else [],
            "changedPathCount": changed_count if available else 0,
            "changedPathsTruncated": (
                bool(workspace.get("changedPathsTruncated")) or changed_count > len(changed_paths)
            ) if available else False,
            "reason": None if available else (
                workspace.get("reason")
                if workspace.get("reason") in self._EVIDENCE_REASONS
                else "evidence-probe-reported-unavailable"
            ),
        }
        safe_events = []
        for event in events[-200:]:
            if not isinstance(event, dict) or not isinstance(event.get("type"), str):
                continue
            projected = {key: event[key] for key in self._EVENT_KEYS if key in event}
            try:
                if len(json.dumps(projected, separators=(",", ":"))) > 8_192:
                    continue
            except (TypeError, ValueError):
                continue
            safe_events.append(projected)
        raw_rejected_events = event_evidence.get("projectionRejectedEvents") if isinstance(event_evidence, dict) else 0
        raw_rejected_checks = event_evidence.get("projectionRejectedChecks") if isinstance(event_evidence, dict) else 0
        rejected_events = raw_rejected_events if isinstance(raw_rejected_events, int) and 0 <= raw_rejected_events <= 1_000_000 else 0
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
            "sourceTruncated": isinstance(event_evidence, dict) and event_evidence.get("sourceTruncated") is True,
            "projectionRejectedEvents": rejected_events,
            "projectionRejectedChecks": rejected_checks,
        }
        if not safe_event_evidence["complete"]:
            reported_reason = event_evidence.get("reason") if isinstance(event_evidence, dict) else None
            allowed_reasons = {
                "harness-events-not-found",
                "harness-events-unreadable",
                "harness-events-byte-limit-exceeded",
                "harness-events-retention-limit-exceeded",
                "harness-events-projection-rejected",
            }
            reason_parts = reported_reason.split(";") if isinstance(reported_reason, str) else []
            safe_event_evidence["reason"] = reported_reason if reason_parts and all(part in allowed_reasons for part in reason_parts) else "harness-event-evidence-unavailable"
        return {
            "workspaceEvidence": safe_workspace,
            "harnessEvents": safe_events,
            "harnessEventEvidence": safe_event_evidence,
            "enforcement": {
                "hooksActive": enforcement.get("hooksActive") is True,
                "source": str(enforcement.get("source") or "unavailable")[:80],
                **(
                    {"policyBypassAchieved": enforcement["policyBypassAchieved"]}
                    if isinstance(enforcement.get("policyBypassAchieved"), bool)
                    else {}
                ),
            },
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
