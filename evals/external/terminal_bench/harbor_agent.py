"""Harbor external agent that bridges to the Node stdio agent (agent.mjs).

Harbor invokes this class via:

    harbor run -d terminal-bench@2.0 --task-name cobol-modernization \
        --agent evals.external.terminal_bench.harbor_agent:StdioBridgeAgent ...

All decision-making (model driver, budget prechecks, telemetry) happens in the
Node process; this wrapper only executes each requested command inside the
Harbor environment and pumps results back over the line-delimited JSON
protocol documented in agent.mjs.

Configuration comes from environment variables set by the release runner:

    HARNESS_EVAL_TB_CONDITION    path to the condition JSON (required)
    HARNESS_EVAL_TB_NODE         node binary (default: "node")
    HARNESS_EVAL_TB_AGENT_MJS    path to agent.mjs (default: alongside this file)

The exact BaseEnvironment exec surface can differ between Harbor releases, so
`_exec` resolves the method defensively and normalizes the result shape. This
wrapper is exercised for real at release time; repository tests cover the Node
side of the protocol.
"""

from __future__ import annotations

import asyncio
import json
import os
import pathlib
import re
import shlex
import tempfile

try:
    from harbor.agents.base import BaseAgent
except ImportError:  # pragma: no cover - lets CI import-check the module without harbor
    BaseAgent = object


class StdioBridgeAgent(BaseAgent):
    _EVIDENCE_PROBE = "/opt/harness-bundle/evidence-probe"
    _EVIDENCE_BEFORE = ".harness/eval-before.json"
    _MAX_PARSED_JSON_BYTES = 2 * 1024 * 1024
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
        """Config comes from --ae agent env vars (self._extra_env), not os.environ."""
        return getattr(self, "_extra_env", {}).get(key) or os.environ.get(key, default)

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
        node = self._cfg("HARNESS_EVAL_TB_NODE", "node")
        agent_mjs = self._cfg(
            "HARNESS_EVAL_TB_AGENT_MJS",
            str(pathlib.Path(__file__).with_name("agent.mjs")),
        )
        instruction_path = pathlib.Path(condition_path).with_suffix(".instruction.txt")
        instruction_path.write_text(instruction)

        # Forward non-secret --ae configuration to the Node bridge. Provider
        # credentials arrive only through this host process's os.environ so
        # Harbor never scopes them into task-container exec calls.
        bridge_env = {**os.environ, **getattr(self, "_extra_env", {})}
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
                    result = await self._exec(
                        environment, message["command"], timeout_ms=message.get("timeoutMs")
                    )
                    reply = {"type": "result", "id": message["id"], **result}
                    proc.stdin.write((json.dumps(reply) + "\n").encode())
                    await proc.stdin.drain()
                elif message["type"] == "done":
                    saw_done = True
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
    def _is_standalone_json_verify(command: str) -> bool:
        """Only strict Harness verification may expose full parsed JSON."""
        if not isinstance(command, str) or any(char in command for char in "\r\n;&|<>`$"):
            return False
        try:
            words = shlex.split(command, posix=True)
        except ValueError:
            return False
        if len(words) < 3 or words[0:2] != ["harness", "verify"] or "--json" not in words:
            return False
        return not any(
            word in {"--dry-run", "--help", "-h"} or word.startswith("--dry-run=")
            for word in words
        )

    @staticmethod
    def _text(value) -> str:
        if value is None:
            return ""
        if isinstance(value, bytes):
            return value.decode("utf-8", errors="replace")
        return str(value)

    async def _exec(
        self,
        environment,
        command: str,
        timeout_ms: int | None = None,
        parse_json: bool = False,
    ) -> dict:
        """Execute a command via whichever exec surface this Harbor exposes."""
        exec_fn = getattr(environment, "exec", None) or getattr(environment, "execute", None)
        if exec_fn is None:
            raise RuntimeError("Harbor environment exposes no exec/execute method")
        try:
            if timeout_ms:
                # harbor 0.20.0 exec supports timeout_sec natively; fall back
                # to wait_for on versions whose exec lacks the kwarg.
                try:
                    result = await exec_fn(
                        command=command, timeout_sec=max(1, int(timeout_ms / 1000))
                    )
                except TypeError:
                    result = await asyncio.wait_for(
                        exec_fn(command=command), timeout=timeout_ms / 1000
                    )
            else:
                result = await exec_fn(command=command)
        except (asyncio.TimeoutError, TimeoutError):
            return {
                "code": 124,
                "stdout": "",
                "stderr": f"command timed out after {timeout_ms}ms",
            }
        code = getattr(result, "return_code", None)
        if code is None:
            code = getattr(result, "exit_code", 0)
        stdout = getattr(result, "output", None)
        if stdout is None:
            stdout = getattr(result, "stdout", "")
        stdout = self._text(stdout)
        stderr = self._text(getattr(result, "stderr", ""))
        normalized = {"code": code, "stdout": stdout[-6000:], "stderr": stderr[-2000:]}

        # Parse the complete stdout before applying the model-visible tail
        # bound. Arbitrary command JSON is not exposed: only a strict
        # standalone `harness verify ... --json` receives `parsedStdout`.
        # Probe calls opt into a private key consumed inside this wrapper.
        expose = self._is_standalone_json_verify(command)
        if (parse_json or expose) and len(stdout.encode("utf-8")) <= self._MAX_PARSED_JSON_BYTES:
            try:
                parsed = json.loads(stdout.strip())
            except (json.JSONDecodeError, TypeError):
                parsed = None
            if parsed is not None:
                if expose:
                    normalized["parsedStdout"] = parsed
                elif parse_json:
                    normalized["_parsedJson"] = parsed
        return normalized

    @staticmethod
    def _unavailable_evidence(reason: str) -> dict:
        return {
            "workspaceEvidence": {
                "available": False,
                "collectionMode": "bounded-content-hash-manifest-v1",
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
                "reason": reason,
                "retainedEvents": 0,
                "sourceTruncated": False,
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
        safe_workspace = {
            "available": available,
            "collectionMode": "bounded-content-hash-manifest-v1",
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
        safe_event_evidence = {
            "available": isinstance(event_evidence, dict) and event_evidence.get("available") is True,
            "reason": None,
            "retainedEvents": len(safe_events),
            "sourceTruncated": isinstance(event_evidence, dict) and event_evidence.get("sourceTruncated") is True,
        }
        if not safe_event_evidence["available"]:
            reported_reason = event_evidence.get("reason") if isinstance(event_evidence, dict) else None
            safe_event_evidence["reason"] = (
                reported_reason
                if reported_reason in {"harness-events-not-found", "harness-events-unreadable"}
                else "harness-event-evidence-unavailable"
            )
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
        try:
            evidence = await self._collect_evidence(environment)
        except Exception:
            evidence = self._unavailable_evidence("evidence-probe-bridge-error")
        done.update(evidence)
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
        payload = {
            "answer": done.get("answer"),
            "stopReason": done.get("stopReason"),
            "steps": done.get("steps"),
            "telemetry": done.get("telemetry"),
            "workspaceEvidence": done.get("workspaceEvidence"),
            "harnessEvents": done.get("harnessEvents"),
            "harnessEventEvidence": done.get("harnessEventEvidence"),
            "enforcement": done.get("enforcement"),
        }
        try:
            existing = getattr(context, "metadata", None)
            if isinstance(existing, dict):
                existing["stdio_bridge"] = payload
            else:
                setattr(context, "metadata", {"stdio_bridge": payload})
        except Exception:
            pass
        totals = (done.get("telemetry") or {}).get("totals") or {}
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
