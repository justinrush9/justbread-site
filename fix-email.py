import os

files = [
    'index.html',
    'faq/index.html',
    'manage/index.html',
    'order/index.html',
    'order-confirmed/index.html',
]

for path in files:
    if not os.path.exists(path):
        continue
    with open(path, 'r', encoding='utf-8') as f:
        content = f.read()
    if 'hello@justbread.shop' in content:
        updated = content.replace('hello@justbread.shop', 'info@justbread.shop')
        with open(path, 'w', encoding='utf-8') as f:
            f.write(updated)
        count = content.count('hello@justbread.shop')
        print(f'Fixed {count} instance(s) in {path}')
    else:
        print(f'No instances in {path}')

print('Done.')
