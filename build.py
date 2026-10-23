#!/usr/bin/env python3
"""把 calendar.html、calendar.css、calendar.js、holidays-data.js 合成單一檔案。

產出：
  dist/採購時程日曆.html  單檔版：資料（seed.json 的案件）包在檔案裡，離線可開、可印
  dist/artifact.html       Claude 版：不含內建資料，案件來自雲端同步

單檔版裡另外附一份自己的範本（base64），所以從任何一份單檔「匯出單檔」
都會得到同樣的程式加上最新的資料。
"""
import base64
import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent
DIST = ROOT / 'dist'


def read(name):
    return (ROOT / name).read_text(encoding='utf-8')


def make_template():
    html = read('calendar.html')
    css = read('calendar.css')
    js = read('calendar.js')
    hol = read('holidays-data.js')
    for text, label in ((css, 'calendar.css'), (js, 'calendar.js'), (hol, 'holidays-data.js')):
        assert '</script' not in text.lower(), f'{label} 不能含有 </script'
    data_mark = '__DATA' + '__'
    self_mark = '__SELF' + '__'
    html = html.replace('<link rel="stylesheet" href="calendar.css">', '<style>\n' + css + '\n</style>', 1)
    html = html.replace('<script src="holidays-data.js"></script>', '<script>\n' + hol + '\n</script>', 1)
    html = html.replace(
        '<script src="calendar.js"></script>',
        '<script>window.EMBED=/*__EMBED_START__*/' + data_mark + '/*__EMBED_END__*/;</script>\n'
        '    <script type="text/plain" id="self-template">' + self_mark + '</script>\n'
        '    <script>\n' + js + '\n</script>', 1)
    assert html.count(data_mark) == 1 and html.count(self_mark) == 1
    return html, data_mark, self_mark


def fill(template, marks, data):
    data_mark, self_mark = marks
    b64 = base64.b64encode(template.encode('utf-8')).decode('ascii')
    payload = 'null' if data is None else json.dumps(data, ensure_ascii=False, separators=(',', ':')).replace('</', '<\\/')
    return template.replace(data_mark, payload, 1).replace(self_mark, b64, 1)


def main():
    template, data_mark, self_mark = make_template()
    seed = None
    seed_path = ROOT / 'seed.json'
    if seed_path.exists():
        seed = json.loads(seed_path.read_text(encoding='utf-8'))
        if isinstance(seed, dict) and 'cases' not in seed:
            seed = {'cases': [seed]}
        elif isinstance(seed, list):
            seed = {'cases': seed}
        seed.setdefault('format', 'procure-calendar')
        seed.setdefault('version', 3)
    DIST.mkdir(exist_ok=True)
    standalone = fill(template, (data_mark, self_mark), seed)
    artifact = fill(template, (data_mark, self_mark), None)
    (DIST / '採購時程日曆.html').write_text(standalone, encoding='utf-8')
    (DIST / 'artifact.html').write_text(artifact, encoding='utf-8')
    print(f'單檔版 {len(standalone.encode("utf-8")) / 1024:.0f} KB，Claude 版 {len(artifact.encode("utf-8")) / 1024:.0f} KB，'
          f'內建案件 {len(seed["cases"]) if seed else 0} 個')


if __name__ == '__main__':
    main()
