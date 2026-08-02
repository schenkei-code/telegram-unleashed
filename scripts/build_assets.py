# -*- coding: utf-8 -*-
"""Renders the hunch-branded README art: a terminal hero (assets/banner.png) and a
horizontal wordmark (assets/logo.png). Same visual identity as the hunch agent —
orange-gold on near-black, JetBrains Mono, the owl. Headless Chrome does the work."""
import subprocess, pathlib, tempfile, base64

ROOT = pathlib.Path(__file__).resolve().parent.parent
ASSETS = ROOT / "assets"
CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"

OWL = "data:image/png;base64," + base64.b64encode((ASSETS / "owl.png").read_bytes()).decode()

CSS = """
@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700;800&display=swap');
*{margin:0;padding:0;box-sizing:border-box}
:root{--orange:#ff8a1e;--gold:#ffd24a;--amber:#ffb43e;--dim:#9c8657;--dimmer:#6c5d3e;
  --green:#7ee7a3;--comment:#6a6a73;--bd:#2a2a31;--ink:#e8e3d6}
body{font-family:'JetBrains Mono',ui-monospace,monospace;color:var(--ink)}
.wm{font-weight:800;letter-spacing:-.02em;line-height:.9;
  background:linear-gradient(110deg,var(--orange) 0%,var(--amber) 50%,var(--gold) 100%);
  -webkit-background-clip:text;background-clip:text;color:transparent;
  filter:drop-shadow(0 3px 22px rgba(255,150,40,.30))}
.cur{color:var(--gold);-webkit-text-fill-color:var(--gold)}
.owl{filter:drop-shadow(0 10px 30px rgba(255,120,20,.28))}
.tag{color:var(--dim)}
.flow{color:var(--gold);font-weight:700}.flow .arr{color:var(--dimmer)}
"""


def render(html, out, w, h, bg="00000000"):
    hp = ASSETS / "_tmp.html"
    hp.write_text(html, encoding="utf-8")
    udd = tempfile.mkdtemp(prefix="tgu_")
    subprocess.run([CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars",
                    f"--user-data-dir={udd}", "--force-device-scale-factor=2",
                    f"--window-size={w},{h}", f"--default-background-color={bg}",
                    "--virtual-time-budget=6000", f"--screenshot={out}", hp.as_uri()],
                   capture_output=True, text=True, timeout=180)
    hp.unlink(missing_ok=True)
    print("ok", out)


# ---------- logo, horizontal, transparent — 1200x360 ----------
logo = f"""<!doctype html><html><head><meta charset='utf-8'><style>{CSS}
body{{width:1200px;height:360px;display:flex;align-items:center;justify-content:center;gap:36px}}
.owl{{height:280px;filter:none}}
.txt{{display:flex;flex-direction:column;justify-content:center}}
.top{{color:var(--orange);font-size:22px;letter-spacing:.24em;text-transform:uppercase;margin-bottom:10px}}
.wm{{font-size:86px;filter:none}}
.sub{{color:var(--dim);font-size:23px;margin-top:12px;letter-spacing:.02em}}
</style></head><body>
<img class='owl' src='{OWL}'>
<div class='txt'>
  <div class='top'>hunch · intentional agent</div>
  <div class='wm'>telegram-unleashed<span class='cur'>▌</span></div>
  <div class='sub'>// your agent, in your pocket — and it types back.</div>
</div>
</body></html>"""

# ---------- banner, terminal hero — 1200x660 ----------
banner = f"""<!doctype html><html><head><meta charset='utf-8'><style>{CSS}
body{{width:1200px;height:556px;padding:30px;
  background:radial-gradient(1200px 700px at 74% -14%, #1c1408 0%, #0a0a0c 56%)}}
.win{{height:100%;border:1px solid var(--bd);border-radius:14px;overflow:hidden;
  background:linear-gradient(180deg,#0f0f12,#0b0b0e);
  box-shadow:0 30px 80px rgba(0,0,0,.55),0 0 0 1px rgba(255,160,60,.06)}}
.bar{{height:44px;display:flex;align-items:center;padding:0 16px;gap:9px;
  background:linear-gradient(180deg,#1a1a1f,#141418);border-bottom:1px solid var(--bd)}}
.dot{{width:12px;height:12px;border-radius:50%}}
.r{{background:#ff5f57}}.y{{background:#febc2e}}.g{{background:#28c840}}
.bartitle{{margin-left:14px;color:#8a8a93;font-size:13px;letter-spacing:.04em}}
.body{{padding:24px 34px 28px}}
.head{{display:flex;align-items:center;gap:24px}}
.owl{{height:112px}}
.wm{{font-size:52px}}
.top{{color:var(--orange);font-size:13px;letter-spacing:.24em;text-transform:uppercase;margin-bottom:7px}}
.sub{{color:var(--dim);font-size:17px;margin-top:16px}}
.flow{{font-size:16px;margin-top:8px}}
.chat{{margin-top:22px;border:1px solid #3a2f17;border-radius:10px;
  background:rgba(255,180,60,.03);padding:22px 20px 18px;position:relative}}
.chatlabel{{position:absolute;top:-11px;left:18px;background:#0c0b0e;padding:0 10px;
  color:var(--orange);font-size:12px;letter-spacing:.10em}}
.msg{{font-size:15px;line-height:1.7}}
.who{{color:var(--dimmer)}}
.status{{color:var(--gold)}}
.reply{{color:var(--ink)}}
.type{{color:var(--comment)}}
.prompt{{margin-top:20px;font-size:15px}}
.pchev{{color:var(--green)}}
.cmd{{color:var(--ink)}}
.note{{color:var(--comment)}}
</style></head><body>
<div class='win'>
  <div class='bar'>
    <div class='dot r'></div><div class='dot y'></div><div class='dot g'></div>
    <div class='bartitle'>telegram-unleashed — claude code, in your pocket</div>
  </div>
  <div class='body'>
    <div class='head'>
      <img class='owl' src='{OWL}'>
      <div>
        <div class='top'>hunch · intentional agent</div>
        <div class='wm'>telegram-unleashed<span class='cur'>▌</span></div>
      </div>
    </div>
    <div class='sub'>// answers that write themselves out, a feed that shows the work, decisions you settle with a thumb.</div>
    <div class='flow'>type <span class='arr'>→</span> stream <span class='arr'>→</span> react <span class='arr'>→</span> settle</div>
    <div class='chat'>
      <div class='chatlabel'>a turn, end to end</div>
      <div class='msg'><span class='who'>you ·</span> ship the auth fix and run the tests</div>
      <div class='msg'><span class='status'>✳ Brewing · 0:04 · reading the repo</span></div>
      <div class='msg'><span class='reply'>Tests green, 41 passed. Pushed as </span><span class='status'>e8ea130</span><span class='reply'>.</span><span class='type'> ▌</span></div>
      <div class='msg'><span class='status'>✳ Brewed · 2m 16s</span></div>
    </div>
    <div class='prompt'><span class='pchev'>~ ❯</span> <span class='cmd'>/plugin install telegram-unleashed@hunch</span>
      <span class='note'>&nbsp;&nbsp;# bun · no build step · your keys stay local</span></div>
  </div>
</div>
</body></html>"""


# ---------- hunch wordmark, transparent — 1000x300 ----------
hunch = f"""<!doctype html><html><head><meta charset='utf-8'><style>{CSS}
body{{width:1000px;height:300px;display:flex;align-items:center;justify-content:center;gap:30px}}
.owl{{height:210px;filter:none}}
.txt{{display:flex;flex-direction:column;justify-content:center}}
.wm{{font-size:108px;filter:none}}
.sub{{color:var(--dim);font-size:22px;margin-top:10px;letter-spacing:.02em}}
</style></head><body>
<img class='owl' src='{OWL}'>
<div class='txt'>
  <div class='wm'>hunch<span class='cur'>▌</span></div>
  <div class='sub'>// intentional agent</div>
</div>
</body></html>"""

if __name__ == "__main__":
    render(logo, str(ASSETS / "logo.png"), 1200, 360)
    render(hunch, str(ASSETS / "hunch.png"), 1000, 300)
    render(banner, str(ASSETS / "banner.png"), 1200, 556, bg="0a0a0c")
