import re

path = 'order/index.html'
with open(path, 'r', encoding='utf-8') as f:
    html = f.read()

original = html
html = html.replace('THREE <span>INGREDIENTS.</span>', 'NINE <span>DAYS.</span>')

if html != original:
    with open(path, 'w', encoding='utf-8') as f:
        f.write(html)
    print('Done - headline updated')
else:
    print('Pattern not found - trying alternate...')
    # Try without span
    html2 = html.replace('THREE INGREDIENTS.', 'NINE DAYS.')
    if html2 != html:
        with open(path, 'w', encoding='utf-8') as f:
            f.write(html2)
        print('Done - alternate pattern updated')
    else:
        print('Could not find headline - manual check needed')
