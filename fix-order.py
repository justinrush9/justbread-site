import re
import base64
import os

path = 'order/index.html'
with open(path, 'r', encoding='utf-8') as f:
    html = f.read()

original_size = len(html)

# Step 1: Extract and save the base64 image
pattern = r"url\('(data:image/(png|jpeg|jpg|webp);base64,([^']+))'\)"
match = re.search(pattern, html)
if match:
    full_uri = match.group(1)
    img_type = match.group(2)
    b64_data = match.group(3)
    ext = 'jpg' if img_type in ('jpeg', 'jpg') else img_type
    img_path = f'images/order-hero.{ext}'
    
    img_bytes = base64.b64decode(b64_data)
    with open(img_path, 'wb') as f:
        f.write(img_bytes)
    print(f'Extracted image -> {img_path} ({len(img_bytes)//1024}KB)')
    
    # Replace data URI with file path
    html = html.replace(f"url('{full_uri}')", f"url('/{img_path}')")
    print('Replaced data URI with file reference')
else:
    print('No base64 image found')

# Step 2: Fix the headline - search for partial matches
for needle in ['THREE', 'INGREDIENTS', 'NINE', 'DAYS', 'FLOUR']:
    idx = html.find(needle)
    if idx >= 0:
        print(f'Found {needle} at {idx}: {repr(html[idx:idx+60])}')

# Step 3: Do the headline replacement
if 'THREE' in html:
    html = html.replace('THREE <span>INGREDIENTS.</span>', 'NINE <span>DAYS.</span>')
    print('Fixed headline: THREE INGREDIENTS -> NINE DAYS')
elif 'INGREDIENTS' in html:
    html = html.replace('INGREDIENTS', 'DAYS')
    html = html.replace('THREE', 'NINE')
    print('Fixed headline via individual replacements')
else:
    print('WARNING: Could not find headline to fix')

# Step 4: Write back
with open(path, 'w', encoding='utf-8') as f:
    f.write(html)

new_size = len(html)
print(f'Done. File: {original_size//1024}KB -> {new_size//1024}KB')
