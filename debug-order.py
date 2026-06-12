path = 'order/index.html'
with open(path, 'r', encoding='utf-8') as f:
    html = f.read()

# Find h1 and h2 tags in HTML body (not CSS)
import re
for m in re.finditer(r'<h[12][^>]*>.*?</h[12]>', html, re.DOTALL):
    print(repr(m.group()[:200]))
    print('---')

# Also find content: property
for m in re.finditer(r"content:\s*['\"]([^'\"]+)['\"]", html):
    print('CSS content:', repr(m.group(1)[:100]))
