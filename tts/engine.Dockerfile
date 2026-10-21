# Official vLLM-Omni release aligned to vLLM 0.30.0 / CUDA 13.0.
# Do not replace with floating latest: VoxCPM2 serving/config APIs evolve.
FROM vllm/vllm-omni:v0.30.0@sha256:fc77cfaac7b1b43c30cbf32eaea214864434c6e0f303e6e9eb9f64104241a994
RUN uv pip install --system --no-cache-dir 'vllm==0.30.0' 'voxcpm==2.0.3' 'ninja==1.11.1.4' 'httpx==0.28.1' \
    && python3 -c "import vllm, vllm_omni, voxcpm, yaml; assert vllm.__version__ == '0.30.0'"
COPY scripts/start-engine.py /usr/local/lib/ats/start-engine.py
ENTRYPOINT ["python3", "/usr/local/lib/ats/start-engine.py"]
