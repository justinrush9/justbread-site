path = 'manage/index.html'
with open(path, 'r', encoding='utf-8') as f:
    html = f.read()

# Print all lines containing --mid or font-size that relate to text
lines = html.split('\n')
for i, line in enumerate(lines):
    if ('page-sub' in line or 'what-list li' in line or 'scope-note' in line or 'help-note' in line) and 'title' not in line:
        print(f'Line {i}: {repr(line[:120])}')
