# Split wow_igcc.html into an artifact-friendly page + supporting data files.
import io, json, os, re, shutil

SRC = r"C:\Users\yuvaraj.m_cmt\wow_igcc.html"
OUT = "C:\\Users\\yuvaraj.m_cmt\\wow_igcc_data\\_artifact"

MAX_FILE = 14 * 1024 * 1024  # stay under the 16MB per-file cap with margin

s = io.open(SRC, encoding="utf-8", errors="strict").read()

# ---- carve out the json payload blocks and the trailing app script ----
payloads = []          # (id, text, start, end_of_block)
for m in re.finditer(r'<script type="application/json" id="([^"]+)">', s):
    pid = m.group(1)
    start = m.end()
    end = s.find("</script>", start)
    assert end > 0, pid
    payloads.append((pid, s[start:end], m.start(), end + len("</script>")))

app_m = None
for m in re.finditer(r"<script>", s):
    app_m = m
assert app_m is not None
app_start = app_m.end()
app_end = s.find("</script>", app_start)
app_js = s[app_start:app_end]

if os.path.isdir(OUT):
    shutil.rmtree(OUT)
os.makedirs(os.path.join(OUT, "data"))

# ---- write data files, sharding anything too large ----
manifest = {}          # element id -> [published paths]
sizes = []
for pid, text, _, _ in payloads:
    nbytes = len(text.encode("utf-8"))
    if nbytes <= MAX_FILE:
        path = "data/%s.json" % pid
        io.open(os.path.join(OUT, path), "w", encoding="utf-8", newline="").write(text)
        manifest[pid] = [path]
        sizes.append((path, nbytes))
    else:
        # split the raw text on character boundaries; the loader re-joins before parsing
        nparts = (nbytes // MAX_FILE) + 1
        step = len(text) // nparts + 1
        paths = []
        for i in range(nparts):
            chunk = text[i * step:(i + 1) * step]
            if not chunk:
                continue
            path = "data/%s.part%d.txt" % (pid, i)
            io.open(os.path.join(OUT, path), "w", encoding="utf-8", newline="").write(chunk)
            paths.append(path)
            sizes.append((path, len(chunk.encode("utf-8"))))
        manifest[pid] = paths

io.open(os.path.join(OUT, "app.js"), "w", encoding="utf-8", newline="").write(app_js)
sizes.append(("app.js", len(app_js.encode("utf-8"))))

# ---- build the page: original markup with the payload blocks emptied ----
page = s
for pid, text, blk_start, blk_end in reversed(payloads):
    page = page[:blk_start] + '<script type="application/json" id="%s"></script>' % pid + page[blk_end:]

total_bytes = sum(n for _, n in sizes)

loader = """
<div id="boot-overlay">
  <div class="boot-box">
    <div class="boot-title">F&amp;V QC Weekly Review</div>
    <div class="boot-sub" id="boot-sub">Loading dashboard data\u2026</div>
    <div class="boot-bar"><div class="boot-bar-fill" id="boot-fill"></div></div>
    <div class="boot-note" id="boot-note">0 of __NFILES__ files</div>
  </div>
</div>
<script>
(function () {
  var MANIFEST = __MANIFEST__;
  var TOTAL_BYTES = __TOTAL__;
  var ids = Object.keys(MANIFEST);
  var nfiles = ids.reduce(function (a, id) { return a + MANIFEST[id].length; }, 0);
  var done = 0;
  var sub = document.getElementById('boot-sub');
  var note = document.getElementById('boot-note');
  var fill = document.getElementById('boot-fill');

  function tick() {
    done++;
    var pct = Math.round((done / nfiles) * 100);
    fill.style.width = pct + '%';
    note.textContent = done + ' of ' + nfiles + ' files';
  }

  function fetchText(path) {
    return fetch(path, { cache: 'force-cache' }).then(function (r) {
      if (!r.ok) throw new Error(path + ' \u2192 HTTP ' + r.status);
      return r.text();
    }).then(function (t) { tick(); return t; });
  }

  sub.textContent = 'Loading ' + (TOTAL_BYTES / 1048576).toFixed(0) + ' MB of data\u2026';

  Promise.all(ids.map(function (id) {
    return Promise.all(MANIFEST[id].map(fetchText)).then(function (parts) {
      document.getElementById(id).textContent = parts.join('');
    });
  })).then(function () {
    sub.textContent = 'Rendering\u2026';
    return new Promise(function (res) { requestAnimationFrame(function () { res(); }); });
  }).then(function () {
    return new Promise(function (res, rej) {
      var el = document.createElement('script');
      el.src = 'app.js';
      el.onload = res;
      el.onerror = function () { rej(new Error('app.js failed to load')); };
      document.body.appendChild(el);
    });
  }).then(function () {
    var ov = document.getElementById('boot-overlay');
    ov.style.opacity = '0';
    setTimeout(function () { ov.remove(); }, 250);
  }).catch(function (err) {
    sub.textContent = 'Could not load the dashboard.';
    note.textContent = String(err && err.message ? err.message : err);
    note.style.color = 'var(--red)';
    fill.style.background = 'var(--red)';
  });
})();
</script>
"""
loader = (loader.replace("__MANIFEST__", json.dumps(manifest))
                .replace("__TOTAL__", str(total_bytes))
                .replace("__NFILES__", str(sum(len(v) for v in manifest.values()))))

boot_css = """
<style>
#boot-overlay{position:fixed;inset:0;z-index:9999;background:var(--bg);display:flex;
  align-items:center;justify-content:center;padding:16px;transition:opacity .25s ease}
#boot-overlay .boot-box{width:100%;max-width:360px;text-align:center}
#boot-overlay .boot-title{font-size:16px;font-weight:700;color:var(--text);margin-bottom:6px}
#boot-overlay .boot-sub{font-size:13px;color:var(--muted);margin-bottom:16px}
#boot-overlay .boot-bar{height:4px;border-radius:2px;background:var(--surface2);overflow:hidden}
#boot-overlay .boot-bar-fill{height:100%;width:0;border-radius:2px;background:var(--accent);
  transition:width .2s ease}
#boot-overlay .boot-note{font-size:11px;color:var(--muted);margin-top:10px;
  font-variant-numeric:tabular-nums}
@media (max-width:480px){.page{padding-left:16px!important;padding-right:16px!important}
  header{padding-left:16px!important;padding-right:16px!important}}
</style>
"""

assert "</head>" in page
page = page.replace("</head>", boot_css + "</head>", 1)

# replace the now-empty inline app script with the loader
old_app_block = page[page.rfind("<script>"):]
assert old_app_block.startswith("<script>")
page = page[:page.rfind("<script>")] + loader + "\n</body>\n</html>\n"

io.open(os.path.join(OUT, "index.html"), "w", encoding="utf-8", newline="").write(page)

print("index.html %.1f KB" % (len(page.encode("utf-8")) / 1024.0))
for p, n in sizes:
    print("  %-40s %8.2f MB" % (p, n / 1048576.0))
print("data total %.2f MB" % (total_bytes / 1048576.0))
print("OUT =", OUT)

