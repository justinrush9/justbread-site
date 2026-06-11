import re

path = 'order/index.html'
with open(path, 'r', encoding='utf-8') as f:
    html = f.read()

original = html

# Toggle buttons - find font-size in .jb-toggle button rule context
# These are on minified single lines so we do simple targeted replacements

replacements = [
    # jb-toggle button font size (11px -> 14px, only in context with letter-spacing: 0.5px and font-weight: 900)
    ('letter-spacing: 0.5px; text-transform: uppercase; cursor: pointer; transition: 0.15s; }', None),  # marker
]

# More targeted: replace font-size: 11px where it appears near specific unique context strings
# Strategy: find each block and replace

import re

# Replace font-size:11px in jb-toggle button (unique: has font-weight:900 and letter-spacing:0.5px)
# The CSS is minified - find the pattern
html = re.sub(
    r'(\.jb-toggle button \{[^}]*?font-size:\s*)11px',
    r'\g<1>14px',
    html
)

# Replace font-size:11px in jb-cadence button
html = re.sub(
    r'(\.jb-cadence button \{[^}]*?font-size:\s*)11px',
    r'\g<1>13px',
    html
)

# Replace font-size:11px in .jb-note
html = re.sub(
    r'(\.jb-note \{[^}]*?font-size:\s*)11px',
    r'\g<1>13px',
    html
)

if html != original:
    with open(path, 'w', encoding='utf-8') as f:
        f.write(html)
    print('Done - font sizes updated in order/index.html')
else:
    print('No changes made - patterns not found. Check CSS manually.')
