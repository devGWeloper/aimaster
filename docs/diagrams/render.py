"""문서 도식 렌더러 — docs/*.md 안의 Mermaid 블록을 SVG·PNG 이미지로 뽑는다.

원본은 md 안의 Mermaid 코드 블록 하나뿐이다(GitHub·VS Code에서 바로 렌더링). 블록 바로 위에
`<!-- diagram: 이름 -->` 주석을 단 블록만 대상으로 하며, 결과는 docs/diagrams/이름.mmd / .svg / .png 로 저장된다.
Word·PPT·PDF로 옮길 때는 이미지를 붙인다.

python docs/diagrams/render.py            # 전체
python docs/diagrams/render.py 이름 ...    # 일부만

필요: Node.js(npx). 브라우저는 내려받지 않고 설치된 Chrome/Edge를 쓴다(PUPPETEER_SKIP_DOWNLOAD).
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
DOCS = HERE.parent
MMDC = "@mermaid-js/mermaid-cli@11.4.2"
BROWSERS = [r"C:\Program Files\Google\Chrome\Application\chrome.exe", r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
            "/usr/bin/google-chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
CONFIG = {"theme": "neutral", "themeVariables": {"fontFamily": "Malgun Gothic, Apple SD Gothic Neo, Noto Sans KR, sans-serif", "fontSize": "15px"},
          "flowchart": {"htmlLabels": True, "curve": "basis", "padding": 12}, "sequence": {"mirrorActors": False}}
BLOCK = re.compile(r"<!--\s*diagram:\s*([\w-]+)\s*-->\s*\n```mermaid\n(.*?)\n```", re.S)


def blocks():
    for md in sorted(DOCS.glob("*.md")):
        for name, src in BLOCK.findall(md.read_text(encoding="utf-8")):
            yield name, src, md.name


def main():
    only = set(sys.argv[1:])
    browser = next((b for b in BROWSERS if Path(b).exists()), None)
    if not browser:
        sys.exit("Chrome/Edge를 찾지 못했습니다. BROWSERS 목록에 경로를 추가하세요.")
    (HERE / ".mmdc-config.json").write_text(json.dumps(CONFIG), encoding="utf-8")
    (HERE / ".puppeteer.json").write_text(json.dumps({"executablePath": browser, "args": ["--no-sandbox"]}), encoding="utf-8")
    env = {**os.environ, "PUPPETEER_SKIP_DOWNLOAD": "1"}
    npx = shutil.which("npx") or shutil.which("npx.cmd")
    done = 0
    for name, src, md in blocks():
        if only and name not in only:
            continue
        mmd = HERE / f"{name}.mmd"
        mmd.write_text(src + "\n", encoding="utf-8")
        for ext, extra in (("svg", []), ("png", ["-s", "2", "-b", "white"])):
            cmd = [npx, "-y", MMDC, "-i", str(mmd), "-o", str(HERE / f"{name}.{ext}"), "-c", str(HERE / ".mmdc-config.json"),
                   "-p", str(HERE / ".puppeteer.json"), *extra]
            r = subprocess.run(cmd, env=env, capture_output=True, text=True, encoding="utf-8", errors="replace")
            if r.returncode:
                sys.exit(f"[실패] {name}.{ext} ({md})\n{r.stderr[-1500:]}")
        done += 1
        print(f"[ok] {name}  ← {md}")
    print(f"{done}개 렌더링 완료 → {HERE}")


if __name__ == "__main__":
    main()
