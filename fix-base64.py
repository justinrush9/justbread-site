import base64
import os

files_to_fix = [
    'faq/index.html',
    'manage/index.html',
]

for path in files_to_fix:
    with open(path, 'r', encoding='utf-8') as f:
        content = f.read().strip()
    
    # Check if it's base64 encoded
    try:
        decoded = base64.b64decode(content).decode('utf-8')
        if decoded.strip().startswith('<!DOCTYPE') or decoded.strip().startswith('<html'):
            print(f'Fixing {path} (was base64 encoded)...')
            with open(path, 'w', encoding='utf-8') as f:
                f.write(decoded)
        else:
            print(f'{path} decoded but doesnt look like HTML, skipping')
    except Exception as e:
        print(f'{path} is not base64, checking if HTML...')
        if content.startswith('<!DOCTYPE') or content.startswith('<html'):
            print(f'  -> {path} is already valid HTML, no fix needed')
        else:
            print(f'  -> {path} unknown format: {e}')

print('Done.')
