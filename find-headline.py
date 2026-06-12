path = 'order/index.html'
with open(path, 'r', encoding='utf-8') as f:
    html = f.read()

# Find and print context around the headline
idx = html.find('FLOUR')
if idx >= 0:
    print('Found FLOUR at index', idx)
    print(repr(html[idx:idx+120]))
else:
    print('FLOUR not found')
