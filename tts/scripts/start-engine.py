#!/usr/bin/env python3
"""Apply deployment concurrency overrides without changing the mounted YAML."""
import os
import re
import sys
import tempfile

import yaml


def bounded(value, name):
    if type(value) is not int or not 1 <= value <= 128:
        raise ValueError(f"{name} must be an integer in 1...128")
    return value


def override(name):
    value = os.environ.get(name, "")
    if not value:
        return None
    if not re.fullmatch(r"[0-9]+", value):
        raise ValueError(f"{name} must be an integer in 1...128")
    return bounded(int(value), name)


def prepare(arguments):
    # Accept both vLLM CLI spellings, and require exactly one deploy config.
    matches = []
    for index, value in enumerate(arguments):
        if value == "--deploy-config":
            if index + 1 >= len(arguments) or arguments[index + 1].startswith("--"):
                raise ValueError("Missing --deploy-config path")
            matches.append((index + 1, arguments[index + 1], False))
        elif value.startswith("--deploy-config="):
            matches.append((index, value.split("=", 1)[1], True))
    if len(matches) != 1:
        raise ValueError("Provide exactly one --deploy-config for VoxCPM2")
    index, source, inline = matches[0]
    with open(source, encoding="utf-8") as handle:
        config = yaml.safe_load(handle)
    stages = config.get("stages") if isinstance(config, dict) else None
    if (not isinstance(stages, list) or len(stages) != 1
            or not isinstance(stages[0], dict) or stages[0].get("stage_id") != 0):
        raise ValueError("VoxCPM2 requires a single stage with stage_id 0")
    stage = stages[0]
    runtime = stage.setdefault("engine_extras", {}).setdefault(
        "hf_overrides", {}).setdefault("voxcpm2_runtime_config", {})
    concurrent = override("TTS_MAX_CONCURRENT")
    sequences = bounded(concurrent if concurrent is not None else stage.get(
        "max_num_seqs"), "max_num_seqs")
    # A shared admission override also resizes the graph pool unless the
    # operator explicitly selects a smaller pool for VRAM/latency tuning.
    graph_override = override("TTS_CUDA_GRAPH_MAX_BATCH_SIZE")
    graph_batch = bounded(graph_override if graph_override is not None else (
        sequences if concurrent is not None else runtime.get(
            "unified_decode_graph_max_batch_size", sequences)),
        "unified_decode_graph_max_batch_size")
    if graph_batch > sequences:
        raise ValueError("Decode graph batch capacity must not exceed max_num_seqs")
    stage["max_num_seqs"] = sequences
    runtime["unified_decode_graph_max_batch_size"] = graph_batch
    # Keep a private, container-local copy; leave all memory/context/quality
    # settings unchanged. vLLM is exec'd so it receives shutdown signals.
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", prefix="ats-voxcpm2-",
                                     suffix=".yaml", delete=False) as handle:
        yaml.safe_dump(config, handle, sort_keys=False)
        rendered = handle.name
    arguments[index] = f"--deploy-config={rendered}" if inline else rendered
    print(f"ATS VoxCPM2 engine: max_num_seqs={sequences}, decode_graph_max_batch_size={graph_batch}", flush=True)
    return arguments


if __name__ == "__main__":
    try:
        command = prepare(sys.argv[1:])
    except (ValueError, OSError, yaml.YAMLError, AttributeError, TypeError) as error:
        # Do not print config content or arbitrary filesystem paths on failure.
        message = str(error) if type(error) is ValueError else "Invalid VoxCPM2 deployment YAML"
        sys.exit(f"ATS VoxCPM2 configuration error: {message}")
    os.execvp("vllm", ["vllm", "serve", *command])
