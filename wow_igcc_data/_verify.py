import io, json, os, re
B = r"C:\Users\yuvaraj.m_cmt\wow_igcc_data\_artifact"
page = io.open(os.path.join(B,"index.html"), encoding="utf-8").read()

ids_in_page = re.findall(r'<script type="application/json" id="([^"]+)"></script>', page)
m = re.search(r"var MANIFEST = (\{.*?\});", page, re.S)
man = json.loads(m.group(1))
print("empty payload slots in page:", ids_in_page)
print("manifest ids            :", sorted(man))
print("ids match               :", sorted(ids_in_page) == sorted(man))

ok = True
for pid, paths in man.items():
    txt = ""
    for p in paths:
        fp = os.path.join(B, p.replace("/", os.sep))
        if not os.path.exists(fp):
            print("MISSING", p); ok = False; continue
        txt += io.open(fp, encoding="utf-8").read()
    try:
        obj = json.loads(txt)
        keys = list(obj)[:5] if isinstance(obj, dict) else type(obj).__name__
        print("  %-16s parses OK  %8.2f MB  parts=%d  keys=%s" % (pid, len(txt.encode())/1048576.0, len(paths), keys))
    except Exception as e:
        print("  %-16s PARSE FAIL: %s" % (pid, e)); ok = False

print()
print("app.js referenced       :", "el.src = 'app.js'" in page)
print("app.js exists           :", os.path.exists(os.path.join(B,"app.js")))
print("inline app script gone  :", "<script>\n const P" not in page and page.count("JSON.parse(document.getElementById('payload')") == 0)
print("has <title>             :", re.search(r"<title>(.*?)</title>", page).group(1))
print("body background set     :", "background:var(--bg)" in page)
print("chart.js cdn            :", "cdn.jsdelivr.net/npm/chart.js" in page)
print("closes properly         :", page.rstrip().endswith("</html>"))
print("ALL OK                  :", ok)
