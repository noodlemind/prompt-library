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

try:
    from harbor.agents.base import BaseAgent
except ImportError:  # pragma: no cover - lets CI import-check the module without harbor
    BaseAgent = object


class StdioBridgeAgent(BaseAgent):
    @staticmethod
    def name() -> str:
        return "engineer-harness-stdio-bridge"

    def version(self) -> str | None:
        return "1"

    async def setup(self, environment) -> None:
        condition = self._load_condition()
        for command in condition.get("setupCommands", []):
            result = await self._exec(environment, command)
            if result["code"] != 0:
                # A failed activation must surface as an infrastructure failure,
                # not run the trial as a silently contaminated treatment arm.
                raise RuntimeError(
                    f"setup command failed (exit {result['code']}): {command}\n{result['stderr']}"
                )

    async def run(self, instruction: str, environment, context) -> None:
        condition_path = os.environ["HARNESS_EVAL_TB_CONDITION"]
        node = os.environ.get("HARNESS_EVAL_TB_NODE", "node")
        agent_mjs = os.environ.get(
            "HARNESS_EVAL_TB_AGENT_MJS",
            str(pathlib.Path(__file__).with_name("agent.mjs")),
        )
        instruction_path = pathlib.Path(condition_path).with_suffix(".instruction.txt")
        instruction_path.write_text(instruction)

        proc = await asyncio.create_subprocess_exec(
            node,
            agent_mjs,
            "--condition",
            condition_path,
            "--instruction",
            str(instruction_path),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            env=os.environ.copy(),
        )
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
                    self._populate_context(context, message)
                    break
        finally:
            if proc.returncode is None:
                proc.terminate()
            await proc.wait()

    def _load_condition(self) -> dict:
        with open(os.environ["HARNESS_EVAL_TB_CONDITION"]) as fh:
            return json.load(fh)

    async def _exec(self, environment, command: str, timeout_ms: int | None = None) -> dict:
        """Execute a command via whichever exec surface this Harbor exposes."""
        exec_fn = getattr(environment, "exec", None) or getattr(environment, "execute", None)
        if exec_fn is None:
            raise RuntimeError("Harbor environment exposes no exec/execute method")
        coro = exec_fn(command=command)
        if timeout_ms:
            # No Harbor version is pinned here, so honor the bridge's
            # per-command timeout portably instead of assuming an exec kwarg.
            try:
                result = await asyncio.wait_for(coro, timeout=timeout_ms / 1000)
            except asyncio.TimeoutError:
                return {
                    "code": 124,
                    "stdout": "",
                    "stderr": f"command timed out after {timeout_ms}ms",
                }
        else:
            result = await coro
        code = getattr(result, "return_code", None)
        if code is None:
            code = getattr(result, "exit_code", 0)
        stdout = getattr(result, "output", None)
        if stdout is None:
            stdout = getattr(result, "stdout", "")
        stderr = getattr(result, "stderr", "") or ""
        return {"code": code, "stdout": (stdout or "")[-6000:], "stderr": stderr[-2000:]}

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
            ("n_cache_read_tokens", totals.get("cachedTokens")),
            ("n_output_tokens", totals.get("outputTokens")),
            ("cost_usd", totals.get("localCostUsd")),
        ):
            if value is None:
                continue
            try:
                setattr(context, attr, value)
            except Exception:
                pass
