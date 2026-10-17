"""Headless UI smoke test for Claude Deck.

Loads the app at phone and tablet sizes, clicks through every panel, and fails on any
console error, uncaught exception or failed request. /api/action calls are intercepted so
nothing is typed into real sessions; pass --live to let them through.

    python3 test/ui_test.py [base_url] [--live]
"""
import json, sys, pathlib
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
TOKEN = json.loads((ROOT / 'config.json').read_text())['token']
BASE = next((a for a in sys.argv[1:] if a.startswith('http')), 'http://127.0.0.1:4747')
LIVE = '--live' in sys.argv

problems, actions = [], []

def watch(page, tag):
    page.on('console', lambda m: m.type == 'error' and problems.append(f'[{tag}] console: {m.text}'))
    page.on('pageerror', lambda e: problems.append(f'[{tag}] pageerror: {e}'))
    page.on('requestfailed', lambda r: 'api/events' not in r.url and problems.append(f'[{tag}] failed: {r.url} {r.failure}'))
    page.on('response', lambda r: r.status >= 400 and problems.append(f'[{tag}] HTTP {r.status}: {r.url}'))
    if not LIVE:
        SAMPLE_DIFF = {'project': 'demo', 'stat': ' 1 file changed, 1 insertion(+), 1 deletion(-)', 'truncated': False, 'untracked': ['new.js'],
                       'patch': 'diff --git a/app.js b/app.js\nindex 1..2 100644\n--- a/app.js\n+++ b/app.js\n@@ -1 +1 @@\n-old <b>\n+new <script>x</script>'}
        def fake(route):
            body = json.loads(route.request.post_data or '{}')
            actions.append(body)
            extra = {'diff': {'diff': SAMPLE_DIFF}, 'clip-get': {'clip': 'https://example.com'}}.get(body.get('type'), {})
            route.fulfill(json={'ok': True, 'msg': 'test ok', **extra})
        page.route('**/api/action', fake)

def check(cond, msg):
    if not cond: problems.append(msg)

def run(browser, tag, w, h):
    page = browser.new_page(viewport={'width': w, 'height': h})
    watch(page, tag)
    page.goto(f'{BASE}/?t={TOKEN}')
    page.wait_for_selector('#conn.on', timeout=8000)
    page.wait_for_timeout(1500)

    # no horizontal overflow
    sw = page.evaluate('document.documentElement.scrollWidth')
    check(sw <= w + 1, f'[{tag}] page overflows horizontally: {sw} > {w}')

    # hero + stats populated
    for sel in ['#lv', '#streak', '#pct', '#sToday', '#vitals .gauge', '#deck .key']:
        check(page.locator(sel).count() > 0, f'[{tag}] missing {sel}')
    check('Lv' in page.inner_text('#lv'), f'[{tag}] level chip empty')
    page.click('#hero svg')
    page.wait_for_timeout(300)

    # theme toggle, sound toggle
    page.click('#themeBtn'); page.click('#themeBtn'); page.click('#soundBtn'); page.click('#soundBtn')

    # session cards
    pids = page.eval_on_selector_all('.sess', 'els => els.map(e => e.dataset.pid)')
    print(f'[{tag}] {len(pids)} session cards')
    for i, pid in enumerate(pids[:4]):  # sessions come and go live; test a few and skip any that close mid-test
        c = page.locator(f'.sess[data-pid="{pid}"]')
        if not c.count(): continue
        c.locator('.row').click(timeout=5000); page.wait_for_timeout(400)
        check('open' in (c.get_attribute('class') or ''), f'[{tag}] card {i} did not open')
        for k in c.locator('.keys .key').all():
            k.click(); page.wait_for_timeout(250)
            if page.locator('#sheet.show').count():
                page.click('#sheetbg', position={'x': 10, 'y': 10}); page.wait_for_timeout(350)
        if c.locator('.macros button').count():
            c.locator('.macros button').first.click()
        c.locator('.say input').fill('hello from the test')
        c.locator('.say button:not(.mic)').click()
        c.locator('.keys .key[data-k="diff"]').click(); page.wait_for_timeout(400)
        check(page.locator('#sheet.show .dfile').count() == 2, f'[{tag}] diff viewer did not render')
        check(page.locator('#sheet script').count() == 0, f'[{tag}] diff not escaped!')
        page.click('#sheetbg', position={'x': 10, 'y': 10}); page.wait_for_timeout(300)
        check(c.locator('.sstats span').count() >= 2, f'[{tag}] card {i} stats missing')
        c.locator('.feedbtn').click(); page.wait_for_timeout(1200)
        check(c.locator('.feed > div').count() > 0, f'[{tag}] card {i} feed empty')
        c.locator('.feedbtn').click()
        c.locator('.row').click()

    # deck keys (new session + timer open sheets)
    page.click('#deck .key[data-type="new-session"]'); page.wait_for_timeout(400)
    check(page.locator('#sheet.show button[data-path]').count() > 0, f'[{tag}] project sheet empty')
    page.click('#sheetbg', position={'x': 10, 'y': 10}); page.wait_for_timeout(300)
    page.click('#deck .key[data-type="timer"]'); page.wait_for_timeout(400)
    check(page.locator('#sheet.show button[data-min]').count() == 6, f'[{tag}] timer sheet wrong')
    page.click('#sheetbg', position={'x': 10, 'y': 10}); page.wait_for_timeout(300)
    for k in page.locator('#deck .key:not([data-type])').all():
        k.click()

    # recent, media, clipboard, activity, today
    check(page.locator('#today div').count() == 3, f'[{tag}] today card empty')
    check(page.locator('#log > div').count() > 0, f'[{tag}] activity log empty')
    if page.locator('#recMore').is_visible(): page.click('#recMore'); page.click('#recMore')
    if page.locator('#recent [data-resume]').count(): page.locator('#recent [data-resume]').first.click()
    for b in page.locator('#mbtns button').all(): b.click()
    page.click('#clipGet'); page.wait_for_timeout(400)
    check(page.locator('#sheet.show #clipText').input_value() == 'https://example.com', f'[{tag}] clipboard sheet wrong')
    page.click('#sheetbg', position={'x': 10, 'y': 10}); page.wait_for_timeout(300)
    page.click('#clipSend'); page.wait_for_timeout(400)
    page.fill('#clipOut', 'hi laptop'); page.click('#clipToLaptop'); page.wait_for_timeout(300)

    # settings: open, budget readout, add + delete a macro (only on first run; restores the list)
    page.click('#setBtn'); page.wait_for_timeout(400)
    check(page.locator('#sheet.show #budget').count() == 1, f'[{tag}] settings did not open')
    if tag == 'phone':
        before = page.locator('#medit .m').count()
        page.fill('#mE', '🧪'); page.fill('#mL', 'UI test'); page.fill('#mT', 'ignore me')
        page.click('#madd button'); page.wait_for_timeout(800)
        check(page.locator('#medit .m').count() == before + 1, f'[{tag}] macro add failed')
        page.locator('#medit .m').last.locator('button').click(); page.wait_for_timeout(800)
        check(page.locator('#medit .m').count() == before, f'[{tag}] macro delete failed')
    page.click('#sheetbg', position={'x': 10, 'y': 10})
    page.wait_for_timeout(500)
    page.screenshot(path=str(ROOT / 'test' / f'shot-{tag}.png'), full_page=True)
    page.close()

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/usr/bin/chromium')
    run(browser, 'phone', 390, 844)
    run(browser, 'ipad', 1180, 820)
    browser.close()

print(f'{len(actions)} actions fired:', sorted({a.get("type") + ":" + str(a.get("key") or a.get("id") or "") for a in actions}))
if problems:
    print('\nPROBLEMS:'); [print(' -', x) for x in problems]; sys.exit(1)
print('ALL GOOD ✅')
