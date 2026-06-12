import os
import re

files = [
    'index.html',
    'order/index.html',
    'faq/index.html',
    'manage/index.html',
    'order-confirmed/index.html',
]

for path in files:
    if not os.path.exists(path):
        continue
    with open(path, 'r', encoding='utf-8') as f:
        html = f.read()
    for needle in ['Nine Days', 'NINE DAYS', 'Nine days', 'nine days', 'Flour. Water', 'FLOUR. WATER']:
        idx = html.find(needle)
        if idx >= 0:
            print(f'{path} -> {needle} at {idx}: {repr(html[idx:idx+80])}')
