"""6단계: 웹 소스 + 엔진 + 데이터 → dist/index.html (파일 하나)

더블클릭(file://)으로도 열리고, 그대로 GitHub Pages 에 올려도 된다.
"""
from __future__ import annotations

import base64
import json

from common import CONFIG_PATH, ROOT, WEB_DATA, log

WEB = ROOT / "web"
ENGINE = ROOT / "engine"
DIST = ROOT / "dist"
JS_ORDER = ["01_dataset.js", "02_services.js", "03_map_view.js", "04_layers.js", "05_panels.js", "06_app.js"]



def check_js_syntax(files):
    """빌드 전에 JS 문법 검사 — 한 파일이라도 틀리면 페이지 전체가 안 뜨므로 여기서 멈춘다."""
    import subprocess
    bad = []
    for f in files:
        r = subprocess.run(["node", "-e", "new Function(require('fs').readFileSync(process.argv[1], 'utf8'))", str(f)],
                           capture_output=True, text=True)
        if r.returncode:
            msg = next((ln for ln in r.stderr.splitlines() if "Error" in ln), "문법 오류")
            bad.append(f"{f.name}: {msg.strip()}")
    if bad:
        raise SystemExit("JS 문법 오류로 빌드를 멈춥니다:\n  " + "\n  ".join(bad))

def main() -> None:
    template = (WEB / "index.html").read_text(encoding="utf-8")
    css = (WEB / "styles.css").read_text(encoding="utf-8")
    check_js_syntax([WEB / "js" / name for name in JS_ORDER] + sorted((ROOT / "engine").glob("*.js")))
    js = "\n\n".join((WEB / "js" / name).read_text(encoding="utf-8") for name in JS_ORDER)
    params = json.dumps(json.loads(CONFIG_PATH.read_text(encoding="utf-8")), ensure_ascii=False, separators=(",", ":"))
    engine = (ENGINE / "seom_engine.js").read_text(encoding="utf-8")
    worker = (ENGINE / "engine_worker.js").read_text(encoding="utf-8")
    for name, text in (("engine", engine), ("worker", worker), ("app", js)):
        if "</script" in text:
            raise ValueError(f"{name} 소스에 </script 문자열이 있어 HTML 에 넣을 수 없습니다")
    data = base64.b64encode((WEB_DATA / "seom_data.bin.gz").read_bytes()).decode("ascii")

    html = (template.replace("__CSS__", css).replace("__PARAMS__", params)
            .replace("__ENGINE_WORKER__", worker).replace("__ENGINE__", engine)
            .replace("__DATA__", data).replace("__JS__", js))
    DIST.mkdir(exist_ok=True)
    out = DIST / "index.html"
    out.write_text(html, encoding="utf-8")
    log(f"저장: {out} ({out.stat().st_size / 1e6:.1f}MB)")


if __name__ == "__main__":
    main()
