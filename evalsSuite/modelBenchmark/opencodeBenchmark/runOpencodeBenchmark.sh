#!/usr/bin/env bash
# OpenCode Agentic Benchmark
# Tests top code-gen models through opencode on a real coding task.
# Handles both tool-calling models (files in session) and markdown-only models.
#
# Usage:
#   ./runOpencodeBenchmark.sh                    # all contender models
#   ./runOpencodeBenchmark.sh --models "gpt-5.4,copilot-gpt-4.1"
#   ./runOpencodeBenchmark.sh --timeout 240      # seconds per model

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BENCHMARK_DIR="$SCRIPT_DIR"
VERIFY_SCRIPT="$BENCHMARK_DIR/verify.mjs"
TASK=$(cat "$BENCHMARK_DIR/task.md")
RESULTS_DIR="$BENCHMARK_DIR/results"
TIMESTAMP=$(date -u +"%Y-%m-%dT%H-%M-%S")
TIMEOUT=180

# Default: top contenders from codeGenBenchmark (>=70% combined)
MODELS=(
    "copilot-gpt-4.1"
    "gpt-5.4"
    "moonshotai/kimi-k2-instruct"
    "gpt-5.3-codex"
    "moonshotai/kimi-k2-instruct-0905"
    "copilot-gpt-4o"
    "codestral-latest"
    "qwen/qwen3-next-80b-a3b-instruct"
    "meta/llama-3.1-405b-instruct"
    "meta/llama-4-maverick-17b-128e-instruct"
)

# Parse arguments
while [[ $# -gt 0 ]]; do
    case "$1" in
        --models) IFS=',' read -ra MODELS <<< "$2"; shift 2 ;;
        --timeout) TIMEOUT="$2"; shift 2 ;;
        --help) echo "Usage: $0 [--models model1,model2] [--timeout secs]"; exit 0 ;;
        *) echo "Unknown arg: $1"; exit 1 ;;
    esac
done

# Load API keys
if [ -f ~/work/.env ]; then
    set -a; source ~/work/.env; set +a
fi

SOUL_API_KEY="${SOUL_GATEWAY_API_KEY:?SOUL_GATEWAY_API_KEY must be set for this explicit external benchmark}"

mkdir -p "$RESULTS_DIR"

TOTAL=${#MODELS[@]}
declare -a MODEL_RESULTS

echo "============================================================"
echo "  OpenCode Agentic Benchmark"
echo "  Task: dependency graph CLI tool (depgraph)"
echo "  Models: $TOTAL"
echo "  Timeout: ${TIMEOUT}s per model"
echo "  Timestamp: $TIMESTAMP"
echo "============================================================"

for i in $(seq 0 $((TOTAL - 1))); do
    model="${MODELS[$i]}"
    num=$((i + 1))
    safe_name=$(echo "$model" | tr '/' '_')
    work_dir="$RESULTS_DIR/$safe_name"

    echo ""
    echo "────────────────────────────────────────────────────────────"
    echo "[$num/$TOTAL] $model"
    echo "────────────────────────────────────────────────────────────"

    # Clean workspace
    rm -rf "$work_dir"
    mkdir -p "$work_dir"

    # Create opencode config with auto-approve and specific model
    cat > "$work_dir/opencode.json" << CONF
{
  "\$schema": "https://opencode.ai/config.json",
  "model": "soul-gateway/$model",
  "provider": {
    "soul-gateway": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Soul Gateway",
      "options": {
        "baseURL": "https://soul.axiologic.dev/v1",
        "apiKey": "$SOUL_API_KEY",
        "headers": { "X-Soul-Agent": "opencode-bench" }
      },
      "models": {
        "$model": {
          "name": "$model",
          "limit": { "context": 200000, "output": 32768 }
        }
      }
    }
  },
  "permission": {
    "read": "allow", "edit": "allow", "glob": "allow", "grep": "allow",
    "list": "allow", "bash": "allow", "task": "allow", "todowrite": "allow",
    "todoread": "allow", "question": "allow", "external_directory": "allow",
    "doom_loop": "allow", "skill": "allow"
  }
}
CONF

    # Init git (opencode needs it)
    cd "$work_dir"
    git init -q 2>/dev/null
    npm init -y > /dev/null 2>&1
    git add -A && git commit -q -m "init" 2>/dev/null

    START_TIME=$(date +%s)

    # Run opencode — capture raw output
    opencode run "$TASK" > "$RESULTS_DIR/${safe_name}.log" 2>&1 &
    OC_PID=$!
    ( sleep "$TIMEOUT"; kill "$OC_PID" 2>/dev/null ) &
    WATCHER_PID=$!
    wait "$OC_PID" 2>/dev/null
    OC_EXIT=$?
    kill "$WATCHER_PID" 2>/dev/null
    wait "$WATCHER_PID" 2>/dev/null

    END_TIME=$(date +%s)
    ELAPSED=$((END_TIME - START_TIME))

    echo "  opencode finished in ${ELAPSED}s (exit: $OC_EXIT)"

    # === Strategy 1: Check if files landed on disk ===
    FILES_ON_DISK=false
    if [ -f "$work_dir/src/depgraph.mjs" ]; then
        FILES_ON_DISK=true
        echo "  Files on disk: yes (tool-calling mode)"
    fi

    # === Strategy 2: Extract from session export ===
    if [ "$FILES_ON_DISK" = false ]; then
        SESSION_ID=$(cd "$work_dir" && opencode session list 2>/dev/null | tail -2 | head -1 | awk '{print $1}')
        if [ -n "$SESSION_ID" ] && [ "$SESSION_ID" != "Session" ]; then
            cd "$work_dir" && opencode export "$SESSION_ID" 2>/dev/null | node -e "
const fs=require('fs'),path=require('path');
const c=[];process.stdin.on('data',d=>c.push(d));process.stdin.on('end',()=>{
    const data=JSON.parse(Buffer.concat(c).toString());
    const text=JSON.stringify(data);
    const re=/\{\"filePath\":\"([^\"]+)\",\"content\":\"((?:[^\"\\\\\\\\]|\\\\\\\\.)*)\"\}/g;
    let m,count=0;
    while((m=re.exec(text))!==null){
        const fp=m[1];
        try{
            const content=JSON.parse('\"'+m[2]+'\"');
            const rel=fp.replace(/.*\\/private\\/tmp\\/[^/]+\\//,'').replace(/.*${safe_name}\\//,'');
            if(!rel.includes('depgraph')&&!rel.includes('tests/'))continue;
            fs.mkdirSync(path.dirname(rel),{recursive:true});
            fs.writeFileSync(rel,content);
            count++;
        }catch(e){}
    }
    if(count>0) process.stderr.write('session-extract:'+count);
});" 2>/dev/null
            if [ -f "$work_dir/src/depgraph.mjs" ]; then
                echo "  Files from session export: yes"
                FILES_ON_DISK=true
            fi
        fi
    fi

    # === Strategy 3: Extract from raw log using extract-files.mjs ===
    if [ "$FILES_ON_DISK" = false ] && [ -f "$RESULTS_DIR/${safe_name}.log" ]; then
        cd "$work_dir"
        node "$BENCHMARK_DIR/extract-files.mjs" "$RESULTS_DIR/${safe_name}.log" "$work_dir" "$safe_name" 2>/dev/null
        if [ -f "$work_dir/src/depgraph.mjs" ]; then
            echo "  Files from log extraction: yes"
            FILES_ON_DISK=true
        fi
    fi

    # === Run verification ===
    if [ "$FILES_ON_DISK" = true ]; then
        cd "$work_dir"
        VERIFY_OUT=$(node "$VERIFY_SCRIPT" "$work_dir" 2>/dev/null || true)
        PASS_RATE=$(echo "$VERIFY_OUT" | node -e "
const c=[];process.stdin.on('data',d=>c.push(d));process.stdin.on('end',()=>{
    try{const d=JSON.parse(Buffer.concat(c).toString());console.log(d.passRate)}
    catch{console.log(0)}
});" 2>/dev/null)
        PASSED=$(echo "$VERIFY_OUT" | node -e "
const c=[];process.stdin.on('data',d=>c.push(d));process.stdin.on('end',()=>{
    try{const d=JSON.parse(Buffer.concat(c).toString());console.log(d.passed+'/'+d.total)}
    catch{console.log('0/0')}
});" 2>/dev/null)

        echo "$VERIFY_OUT" > "$RESULTS_DIR/${safe_name}-verify.json"

        if [ "${PASS_RATE:-0}" = "100" ]; then
            echo "  ✅ PASS $PASSED checks (${ELAPSED}s)"
        else
            echo "  ❌ FAIL $PASSED checks — ${PASS_RATE}% (${ELAPSED}s)"
        fi
        MODEL_RESULTS+=("$model|$PASS_RATE|$PASSED|$ELAPSED")
    else
        echo "  ❌ FAIL — no files produced (${ELAPSED}s)"
        MODEL_RESULTS+=("$model|0|0/0|$ELAPSED")
        echo '{"passed":0,"failed":1,"total":1,"passRate":0,"error":"no files produced"}' > "$RESULTS_DIR/${safe_name}-verify.json"
    fi
done

# === Summary ===
echo ""
echo "============================================================"
echo "  RESULTS — OpenCode Agentic Benchmark"
echo "============================================================"
echo ""
printf "%-45s %8s %10s %10s\n" "Model" "Score" "Checks" "Time"
printf "%s\n" "$(printf '─%.0s' {1..78})"

# Sort by score descending
IFS=$'\n' SORTED=($(for r in "${MODEL_RESULTS[@]}"; do echo "$r"; done | sort -t'|' -k2 -rn))

for entry in "${SORTED[@]}"; do
    IFS='|' read -r m_name m_score m_checks m_time <<< "$entry"
    if [ "${m_score:-0}" = "100" ]; then
        printf "  ✅ %-43s %6s%% %10s %8ss\n" "$m_name" "$m_score" "$m_checks" "$m_time"
    elif [ "${m_score:-0}" -gt 0 ] 2>/dev/null; then
        printf "  ⚠️  %-43s %6s%% %10s %8ss\n" "$m_name" "$m_score" "$m_checks" "$m_time"
    else
        printf "  ❌ %-43s %6s%% %10s %8ss\n" "$m_name" "${m_score:-0}" "$m_checks" "$m_time"
    fi
done

echo ""

# Save summary JSON
node -e "
const results = [$(for r in "${MODEL_RESULTS[@]}"; do
    IFS='|' read -r n s c t <<< "$r"
    echo "{\"model\":\"$n\",\"score\":$s,\"checks\":\"$c\",\"elapsed\":$t},"
done)];
const out = { timestamp: '$TIMESTAMP', task: 'depgraph', timeout: $TIMEOUT, results };
process.stdout.write(JSON.stringify(out, null, 2));
" > "$RESULTS_DIR/summary-${TIMESTAMP}.json" 2>/dev/null

echo "Results saved to $RESULTS_DIR/summary-${TIMESTAMP}.json"
